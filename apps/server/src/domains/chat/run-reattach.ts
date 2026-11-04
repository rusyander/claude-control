import { connect } from 'node:net';
import { providerCliCommand } from '../../providers/cli/cli.ts';
import { getProvider, isKnownProviderId, listProviders } from '../../providers/registry.ts';
import type { RunOptions } from './run-options/run-options.ts';
import type { RunMeta } from './ChatRunRegistry/ChatRunRegistry.types.ts';
import type { RunLedgerEntry } from './run-ledger/run-ledger.ts';

/**
 * Прогон из журнала после перезапуска панели: чем его продолжить (команда, провайдер,
 * параметры, мета) и как отпустить посредника прежней версии. Своих посредников панель
 * больше не поднимает (этап 10, G14: ход ведёт ядро) — запись с каналом приходит только
 * от сервера до обновления, и ей закрывают ввод (`endRelayInput`).
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
 * Посредника прежней версии не подхватывают — ему закрывают ввод: CLI
 * доделает ход и выйдет, как выходил до посредника, — а прогон дочитает ответ
 * из транскрипта по жизни pid (`DetachedRun`).
 */
export function endRelayInput(entry: RunLedgerEntry): void {
  const relay = entry.relay;
  if (!relay) return;
  const socket = connect(relay.pipe);
  // Канала нет — посредник уже ушёл, закрывать нечего.
  socket.on('error', () => socket.destroy());
  socket.once('connect', () => {
    // Ключ канала — первой строкой: без него посредник с ключом строк не принимает.
    if (relay.token) {
      socket.write(`${JSON.stringify({ type: 'relay_hello', token: relay.token })}\n`);
    }
    // Конец ввода и сразу конец подключения: держать канал к чужому процессу незачем.
    socket.end(`${JSON.stringify({ type: 'relay_end' })}\n`);
  });
}
