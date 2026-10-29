import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { channelPath } from '../../platform/control-channel.ts';
import { waitFor } from '../../platform/__fixtures__/harness.ts';
import { attachSession } from '../../session-host/client.ts';
import { runHost } from '../../session-host/host.ts';
import { sessionFile, type ExitRecord, type HostSpec } from '../../session-host/protocol.ts';
import { stopSession } from './session-io.ts';

/**
 * Сомнение остановки дерева (`TreeStopReport.unknown`) доходит до ядра, а не теряется в хосте:
 * сообщение `stopped`, exit.json и `StopOutcome` несут причину. Хост — в процессе теста (как в
 * `host.test.ts`), CLI и канал настоящие; подменён только поиск по метке — внешнее чтение ОС,
 * отказ которого на исправной машине иначе не вызвать.
 */

const CLI = fileURLToPath(
  new URL('../../session-host/__fixtures__/numbered-cli.mjs', import.meta.url),
);
const TOKEN = 'a'.repeat(48);
const root = mkdtempSync(join(tmpdir(), 'host-stop-unknown-'));
const SWEEP_DOWN = 'environment of processes unreadable (test)';
const treeStop = {
  sweep: () => Promise.resolve({ unknown: SWEEP_DOWN }),
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function plant(name: string): string {
  const dir = mkdtempSync(join(root, `${name}-`));
  const sessionId = `stop-unknown-${name}-${process.pid}-${Date.now()}`;
  writeFileSync(sessionFile(dir, 'token'), TOKEN);
  const spec: HostSpec = {
    v: 1,
    sessionId,
    command: process.execPath,
    args: [CLI],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), COUNT: '100000', PACE_MS: '20' },
    channel: channelPath(sessionId),
  };
  writeFileSync(sessionFile(dir, 'spec'), JSON.stringify(spec));
  return dir;
}

const hostReady = (dir: string) =>
  waitFor(() => (existsSync(sessionFile(dir, 'host')) ? true : undefined));

const readExit = (dir: string): ExitRecord =>
  JSON.parse(readFileSync(sessionFile(dir, 'exit'), 'utf8')) as ExitRecord;

describe('session host: an unproven tree stop is carried, never reported clean', () => {
  it('stopped message and exit.json carry unknown; a later stop of the exited session reports it too', async () => {
    const dir = plant('channel');
    const running = runHost(dir, { treeStop });
    await hostReady(dir);
    const attached = await attachSession(dir);
    if (attached.state !== 'live') throw new Error(JSON.stringify(attached));
    const report = await attached.session.stop(1_000);
    attached.session.close();
    await running;
    // CLI снят настоящей остановкой (остатка нет), но поиск по метке не ответил — не доказано.
    expect(report.residual).toEqual([]);
    expect(report.unknown).toContain(SWEEP_DOWN);
    const exit = readExit(dir);
    expect(exit).toMatchObject({ stopped: true });
    expect(exit.unknown).toContain(SWEEP_DOWN);
    const again = await stopSession(dir, 'tree', 1_000, 0);
    expect(again.how).toBe('already-exited');
    expect(again.unknown).toContain(SWEEP_DOWN);
  }, 60_000);

  it('stopSession tree on a live host answers with the unknown of the host stop', async () => {
    const dir = plant('session-io');
    const running = runHost(dir, { treeStop });
    await hostReady(dir);
    // Хост здесь — сам процесс теста: ждать его ухода незачем (он в остатке как живой хост).
    const outcome = await stopSession(dir, 'tree', 1_000, 0);
    await running;
    expect(outcome.how).toBe('tree');
    expect(outcome.unknown).toContain(SWEEP_DOWN);
  }, 60_000);

  it('an old-format exit.json without the field still reads: already-exited, no unknown', async () => {
    const dir = mkdtempSync(join(root, 'old-'));
    writeFileSync(
      sessionFile(dir, 'exit'),
      JSON.stringify({ v: 1, code: 0, signal: null, stopped: true, at: 1 }),
    );
    expect(await stopSession(dir, 'tree')).toEqual({
      how: 'already-exited',
      residual: [],
      code: 0,
    });
  });
});
