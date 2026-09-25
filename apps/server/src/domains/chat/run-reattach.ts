import type { RunOptions } from './ChatRunner.ts';
import type { RunMeta } from './ChatRunRegistry.ts';
import { LiveSession, type LiveSessionPool } from './live-session.ts';
import { connectRelay } from './live-transport.ts';
import type { RunLedgerEntry } from './run-ledger.ts';

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

/** Параметры прогона из записи журнала — тот же набор, что знает `adopt`. */
export function ledgerRunOptions(entry: RunLedgerEntry): RunOptions {
  return {
    prompt: '',
    cwd: entry.cwd,
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
    { pipe: relay.pipe, pid: relay.pid },
    {
      command: '',
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
    { pipe: relay.pipe, pid: relay.pid },
    { line: () => undefined, stderr: () => undefined, close: () => undefined },
  );
  transport.end();
}
