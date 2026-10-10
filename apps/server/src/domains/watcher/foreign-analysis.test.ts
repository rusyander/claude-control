import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive } from '../chat/run-ledger/run-ledger.ts';
import { MAX_PROMPT_CHARS } from '../provider-chat/prompt/prompt.ts';
import { getProvider } from '../../providers/registry.ts';
import { fitForeignBatch, foreignWatchPrompt, startForeignAnalysis } from './foreign-analysis.ts';
import type { WatchEvent } from './types.ts';

/**
 * Разбор самим чужим CLI (X9): задание уходит элементом argv, поэтому пачка
 * ужимается под предел командной строки, а выключенный наблюдатель снимает
 * процесс. Настоящие здесь сборка задания, запуск через `runProviderCli` и
 * argv каталога Qwen; вместо `qwen` — node с фальшивым CLI.
 */
const FAKE = fileURLToPath(new URL('./__fixtures__/fake-claude.mjs', import.meta.url));

function event(id: string, stackChars: number): WatchEvent {
  return {
    id,
    ref: `WR-${id}`,
    entryClass: 'failure',
    severity: 'medium',
    analyzedCount: 0,
    fingerprint: id,
    source: 'server',
    kind: 'http-5xx',
    message: `boom ${id}`,
    stack: 'x'.repeat(stackChars),
    count: 1,
    firstSeen: '2026-10-10T10:00:00.000Z',
    lastSeen: '2026-10-10T10:00:00.000Z',
  } as WatchEvent;
}

describe('пачка для чужого CLI', () => {
  it('ужимается, пока задание не влезет в предел argv; влезающая — целиком', () => {
    const events = Array.from({ length: 10 }, (_, i) => event(`e${i}`, 5000));
    const batch = fitForeignBatch(events, () => [], 'ru');
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(10);
    expect(foreignWatchPrompt(batch, [], 'ru').length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    // Ещё один сбой уже не влез бы — иначе пачка ужата зря.
    const next = events.slice(0, batch.length + 1);
    expect(foreignWatchPrompt(next, [], 'ru').length).toBeGreaterThan(MAX_PROMPT_CHARS);

    const small = events.map((item) => ({ ...item, stack: 'short' }));
    expect(fitForeignBatch(small, () => [], 'ru')).toHaveLength(10);
  });

  it('один сбой длиннее предела — всё равно в разбор, а не вечно в кольце', () => {
    expect(fitForeignBatch([event('huge', 50_000), event('next', 10)], () => [], 'ru')).toEqual([
      expect.objectContaining({ id: 'huge' }),
    ]);
  });
});

describe('разбор чужим CLI: остановка', () => {
  let cwd: string;
  const spawned: ChildProcess[] = [];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cc-watch-foreign-'));
  });
  afterEach(() => {
    for (const child of spawned.splice(0)) if (child.pid && isPidAlive(child.pid)) child.kill();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('выключили наблюдателя — процесс снят, исход «остановлен», pid отдан наблюдателю', async () => {
    writeFileSync(join(cwd, 'fake-config.json'), JSON.stringify({ sleepMs: 60_000 }));
    const pids: number[] = [];
    let exited = false;
    const handle = startForeignAnalysis({
      foreign: { provider: getProvider('qwen'), command: process.execPath },
      cwd,
      events: [event('a1', 10)],
      spawnImpl: ((command: string, args: string[], options: object) => {
        const child = spawn(command, [FAKE, ...args], options);
        spawned.push(child);
        return child;
      }) as never,
      onSpawn: (pid) => pids.push(pid),
      onExit: () => {
        exited = true;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pids).toHaveLength(1);
    handle.stop();
    const outcome = await handle.done;
    expect(outcome).toMatchObject({ ok: false, stopped: true });
    expect(exited).toBe(true);
    expect(isPidAlive(pids[0]!)).toBe(false);
  });
});
