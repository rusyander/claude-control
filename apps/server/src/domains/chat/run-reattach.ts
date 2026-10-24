import { providerCliCommand } from '../../providers/cli/cli.ts';
import { getProvider, isKnownProviderId, listProviders } from '../../providers/registry.ts';
import type { RunOptions } from './ChatRunner/ChatRunner.ts';
import type { RunMeta } from './ChatRunRegistry/ChatRunRegistry.types.ts';
import { LiveSession, type LiveSessionPool } from './live-session/live-session.ts';
import { connectRelay } from './live-transport/live-transport.ts';
import type { RunLedgerEntry } from './run-ledger/run-ledger.ts';

/**
 * Подхват живой сессии после перезапуска панели — через посредника.
 *
 * До посредника у перезапуска был один исход: процесс CLI жив, трубы к нему нет,
 * прогон «усыновлён без потока» (`DetachedRun`), а в конце хода CLI уходил по
 * концу ввода и уносил фон. Теперь трубы держит посредник (`live-relay.mjs`), и
 * запись журнала несёт его канал: новый сервер подключается, получает вывод,
 * накопленный без него, и дальше ведёт сессию как свою — ходы, пробуждения
 * после фона, «Остановить».
 */

/** Провайдер, чья это команда запуска (имя без каталога и регистра на Windows); чужая — `undefined`. */
export function providerOfCommand(command: string): string | undefined {
  const name = command.trim().replace(/^"|"$/g, '');
  const base = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  return listProviders().find((provider) =>
    [provider.cli.command, provider.cli.windowsCommand].some(
      (known) => known === name || known.toLowerCase() === base,
    ),
  )?.id;
}

/**
 * Что журнал прогонов должен знать о запуске, чтобы продолжение усыновлённого
 * прогона подняло тот же CLI (EF-190): команда, её провайдер, каталог
 * конфигурации и источники настроек. Окружение — нет: в нём бывают ключи.
 */
export function ledgerLaunchOf(
  options: Pick<RunOptions, 'command' | 'configDir' | 'settingSources'>,
): Pick<RunLedgerEntry, 'command' | 'provider' | 'configDir' | 'settingSources'> {
  const provider = options.command ? providerOfCommand(options.command) : undefined;
  return {
    ...(options.command ? { command: options.command } : {}),
    ...(provider ? { provider } : {}),
    ...(options.configDir ? { configDir: options.configDir } : {}),
    ...(options.settingSources ? { settingSources: options.settingSources } : {}),
  };
}

/** Записи без команды, о которых сервер уже сказал: одна строка на запись, не на каждый вызов. */
const toldWithoutCommand = new Set<string>();

/**
 * Команда запуска по записи: записанная; нет её (поле было битым) — команда
 * записанного провайдера для этой ОС; нет и провайдера — `undefined`, то есть
 * CLI по умолчанию.
 */
function commandOf(entry: RunLedgerEntry): string | undefined {
  if (entry.command) return entry.command;
  return entry.provider && isKnownProviderId(entry.provider)
    ? providerCliCommand(getProvider(entry.provider))
    : undefined;
}

/**
 * Параметры прогона из записи журнала — тот же набор, что знает `adopt`, и
 * команда запуска. Запись прежней версии без команды и провайдера — CLI по
 * умолчанию, с одной строкой в журнале сервера: молча подменённый CLI и был
 * ошибкой.
 */
export function ledgerRunOptions(
  entry: RunLedgerEntry,
  log: (message: string) => void = (message) => console.warn(message),
): RunOptions {
  const command = commandOf(entry);
  if (!command && !toldWithoutCommand.has(entry.key)) {
    toldWithoutCommand.add(entry.key);
    log(
      `run ledger: entry ${entry.key} has no command (older panel); continuing with the default CLI`,
    );
  }
  return {
    prompt: '',
    cwd: entry.cwd,
    ...(command ? { command } : {}),
    ...(entry.configDir ? { configDir: entry.configDir } : {}),
    ...(entry.settingSources ? { settingSources: entry.settingSources } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
    ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
    // Ключ хода брокер прав читает из файла сессии: ход, начатый CLI после
    // подхвата, пишет туда свой — без этого запросы прав шли бы прежнему ключу.
    ...(entry.relay?.runIdFile ? { permissionPrompt: { runId: entry.key, baseUrl: '' } } : {}),
  };
}

export function ledgerRunMeta(entry: RunLedgerEntry): RunMeta {
  return {
    ...(entry.origin ? { origin: entry.origin } : {}),
    ...(entry.projectPath ? { projectPath: entry.projectPath } : {}),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    ...(entry.local ? { local: true as const } : {}),
    ...(entry.lowered ? { lowered: entry.lowered } : {}),
  };
}

/**
 * Подключиться к посреднику записи и отдать сессию пулу. `undefined` — не к
 * чему: запись без посредника или без `sessionId` (пул знает сессии только по
 * нему). Ход в записи не `idle` — сессия подхвачена посреди хода, и его
 * накопленный вывод ждёт прогона, который его заберёт.
 */
export function reattachSession(
  entry: RunLedgerEntry,
  pool: LiveSessionPool,
): LiveSession | undefined {
  const relay = entry.relay;
  if (!relay || !entry.sessionId) return undefined;
  const session = LiveSession.reattach(
    { pipe: relay.pipe, pid: relay.pid, ...(relay.token ? { token: relay.token } : {}) },
    {
      // Процесс уже идёт за посредником, нового по этой записи не поднимут; команда —
      // для сообщений о сбое процесса, тем же именем, что у него.
      command: commandOf(entry) ?? '',
      args: [],
      cwd: entry.cwd,
      env: {},
      shell: false,
      signature: relay.signature,
      ...(relay.tempDir ? { tempDir: relay.tempDir } : {}),
      ...(relay.runIdFile ? { runIdFile: relay.runIdFile } : {}),
    },
    { sessionId: entry.sessionId, inTurn: !entry.idle, background: relay.background ?? 0 },
  );
  pool.keep(session);
  return session;
}

/**
 * Посредник без `sessionId` подхватить в пул нельзя. Ему закрывают ввод: CLI
 * доделает ход и выйдет, как выходил до посредника, — а прогон дочитает ответ
 * из транскрипта по жизни pid (`DetachedRun`).
 */
export function endRelayInput(entry: RunLedgerEntry): void {
  const relay = entry.relay;
  if (!relay) return;
  const transport = connectRelay(
    { pipe: relay.pipe, pid: relay.pid, ...(relay.token ? { token: relay.token } : {}) },
    { line: () => undefined, stderr: () => undefined, close: () => undefined },
  );
  transport.end();
}
