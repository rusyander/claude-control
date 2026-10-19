import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heavyQueueWait } from './heavy-wait.ts';

/**
 * «Ждёт очередь» у группы в хабе — по билетам НАСТОЯЩЕГО хука очереди: билет
 * пишет и убирает `acquire` из `tools/heavy-queue-hook.mjs`, тест только ставит
 * три сессии в очередь из одного места и читает, что видит индикатор.
 */
const HOOK = resolve(__dirname, '../../../../../tools/heavy-queue-hook.mjs');
const { acquire } = (await import(pathToFileURL(HOOK).href)) as {
  acquire: (
    dir: string,
    input: { session_id: string; tool_use_id: string; tool_input: { command: string } },
  ) => Promise<number | null>;
};

const input = (session: string) => ({
  session_id: session,
  tool_use_id: `${session}-call`,
  tool_input: { command: 'pnpm test' },
});

const saved = {
  wait: process.env.AGENTDECK_HEAVY_MAX_WAIT_MS,
  poll: process.env.AGENTDECK_HEAVY_POLL_MS,
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-heavy-wait-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ slots: 1 }));
  process.env.AGENTDECK_HEAVY_MAX_WAIT_MS = '600';
  process.env.AGENTDECK_HEAVY_POLL_MS = '20';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['AGENTDECK_HEAVY_MAX_WAIT_MS', saved.wait],
    ['AGENTDECK_HEAVY_POLL_MS', saved.poll],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe('ожидание в очереди тяжёлых шагов', () => {
  it('держатель места не ждёт, ждущие видят своё ожидание и сколько чужих впереди', async () => {
    // Сессия A берёт единственное место, B и C встают за ней по порядку.
    expect(await acquire(dir, input('A'))).not.toBeNull();
    const before = Date.now();
    const waitB = acquire(dir, input('B'));
    await tick(30);
    const waitC = acquire(dir, input('C'));
    await tick(60);

    expect(heavyQueueWait(dir, 'A')).toBeUndefined();
    const b = heavyQueueWait(dir, 'B');
    const c = heavyQueueWait(dir, 'C');
    expect(b).toMatchObject({ ahead: 0, command: 'pnpm test' });
    expect(c).toMatchObject({ ahead: 1, command: 'pnpm test' });
    expect(Date.parse(b?.since ?? '')).toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(c?.since ?? '')).toBeGreaterThan(Date.parse(b?.since ?? ''));

    // Ожидание вышло — хук убрал билеты, и ждать больше некому.
    expect(await waitB).toBeNull();
    expect(await waitC).toBeNull();
    expect(heavyQueueWait(dir, 'B')).toBeUndefined();
    expect(heavyQueueWait(dir, 'C')).toBeUndefined();
  });

  it('билет мёртвого хука не числится ожиданием', () => {
    mkdirSync(join(dir, 'tickets'));
    writeFileSync(
      join(dir, 'tickets', '000000000000001-4242-B.json'),
      JSON.stringify({ pid: 4242, session: 'B', created: 1, command: 'pnpm build' }),
    );
    expect(heavyQueueWait(dir, 'B', () => false)).toBeUndefined();
    expect(heavyQueueWait(dir, 'B', () => true)).toMatchObject({
      since: new Date(1).toISOString(),
      ahead: 0,
      command: 'pnpm build',
    });
  });

  it('нет каталога очереди или сессии — нет ожидания', () => {
    expect(heavyQueueWait(join(dir, 'missing'), 'B')).toBeUndefined();
    expect(heavyQueueWait(dir, '')).toBeUndefined();
  });
});
