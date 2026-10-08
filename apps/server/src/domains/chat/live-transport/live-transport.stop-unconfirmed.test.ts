import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killPidTree, type KillOptions } from '../../../lib/process-tree/process-tree.ts';
import { ChatRun } from '../ChatRunner/ChatRunner.ts';
import { ChatRunRegistry, type BufferedEvent } from '../ChatRunRegistry/ChatRunRegistry.ts';
import { DEFAULT_LIVE_LIMITS, LiveSessionPool } from '../live-session/live-session.ts';
import { connectRelay, type TransportOpener } from './live-transport.ts';
import { isPidAlive } from '../run-ledger/run-ledger.ts';

/**
 * Ревью 28.09 (F-145, остаток): «Остановить» живой сессии, когда канала
 * посредника нет (ещё не поднялся или оборвался), снимает посредника деревом по
 * pid со сверкой времени (`spawnedAt`). Снимка процессов нет (таймаут или отказ
 * системы, F-205) — `killPidTree` честно не трогает номер и отдаёт `[]`, а
 * транспорт молчал, и реестр помечал прогон остановленным: посредник с CLI
 * работали дальше без присмотра, а человек видел «остановлено». Правило то же,
 * что у усыновлённого прогона (`DetachedRun.stop`): непроверенный живой pid —
 * не «остановлен», прогон остаётся, человеку сказано.
 *
 * Настоящие здесь процесс-«посредник», канал (труба, которая не отвечает),
 * `connectRelay`, `LiveSession`, `ChatRun`, реестр и `killPidTree`; подменён
 * только снимок процессов — он и есть граница, которая отказала.
 */

let child: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;
let cwd: string | undefined;

afterEach(() => {
  if (child?.pid && isPidAlive(child.pid)) child.kill('SIGKILL');
  // Процесса уже нет — остановка по номеру проходит, реестр пуст.
  registry?.stopAll();
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  child = undefined;
  registry = undefined;
  cwd = undefined;
});

function pipeName(): string {
  const id = `agentdeck-test-${process.pid}-${randomBytes(6).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

const waitFor = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/**
 * Живой прогон, чей «посредник» — настоящий процесс, а канал его не отвечает:
 * «Остановить» уходит в запасной путь — снятие по pid.
 */
async function liveRunWithoutChannel(snapshot: 'missing' | 'present') {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = child.pid!;
  const killTree = (target: number, options: KillOptions): readonly number[] =>
    snapshot === 'missing'
      ? killPidTree(target, options, { platform: 'win32', readTable: () => undefined })
      : killPidTree(target, options);
  const open: TransportOpener = (_launch, handlers) =>
    connectRelay({ pipe: pipeName(), pid }, handlers, 60_000, { killTree });
  const pool = new LiveSessionPool(DEFAULT_LIVE_LIMITS, Date.now, open);
  let run: ChatRun | undefined;
  registry = new ChatRunRegistry(() => (run = new ChatRun(pool)));
  cwd = mkdtempSync(join(tmpdir(), 'cc-relay-stop-'));
  expect(registry.start('new-relay', { prompt: 'привет', cwd }, { projectPath: cwd })).toBe(true);
  const events: BufferedEvent['event'][] = [];
  let closed = false;
  registry.attach('new-relay', 0, {
    send: (buffered) => events.push(buffered.event),
    close: () => {
      closed = true;
    },
  });
  // Ход ушёл в очередь транспорта: сессия поднята, её pid — наш «посредник».
  await waitFor(() => run?.pid === pid);
  return { pid, events, isClosed: () => closed };
}

describe('«Остановить» без канала посредника (F-145, live-transport)', { timeout: 20_000 }, () => {
  it('снимка нет — посредник жив: прогон не «остановлен», человек знает, повтор возможен', async () => {
    const { pid, events, isClosed } = await liveRunWithoutChannel('missing');

    const outcome = registry!.stopByHuman('new-relay');

    expect(isPidAlive(pid)).toBe(true);
    expect(outcome).toBe('unconfirmed');
    expect(registry!.isRunning('new-relay')).toBe(true);
    expect(isClosed()).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'notice',
        code: 'stopUnconfirmed',
        textCode: 'chat-stop-unconfirmed-notice',
      }),
    );

    // Процесс ушёл — повторное «Остановить» проходит: номера нет, снимать нечего.
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child!.kill('SIGKILL');
    await exited;
    expect(registry!.stopByHuman('new-relay')).toBe('stopped');
    expect(isClosed()).toBe(true);
  });

  it('снимок есть — посредник снят деревом, прогон остановлен', async () => {
    const { pid, isClosed } = await liveRunWithoutChannel('present');
    expect(registry!.stopByHuman('new-relay')).toBe('stopped');
    await waitFor(() => !isPidAlive(pid));
    expect(isClosed()).toBe(true);
  });
});
