import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { SplitGroupPaused, SplitPlanCancelled } from '@agentdeck/contracts/chat-handoff';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import type { TreePauseRecord } from '../../../lib/app-store/app-store.types.ts';
import { killPidTree } from '../../../lib/process-tree/process-tree.ts';
import { registerSplitControlRoutes } from '../../../routes/chat/split-control-routes.ts';
import type { SplitLaunchDeps } from '../../../routes/chat/split-launch.ts';
import { ChatRunRegistry, type RunLedgerSink } from './ChatRunRegistry.ts';
import { isPidAlive, type RunLedgerEntry } from '../run-ledger/run-ledger.ts';
import type { SplitConveyor } from '../split-conveyor/split-conveyor.ts';
import { TreePause } from '../tree-pause/tree-pause.ts';
import { createTreeRuns } from '../tree-runs/tree-runs.ts';

/**
 * F-145, соседи (ревью 28.09): «Остановить» по кнопке уже честно говорит
 * «не остановлен», когда номер CLI нечем проверить. Но внутренние остановки —
 * пауза дерева, пауза и отмена группы разделения — брали `stop()` булевым, и
 * `unconfirmed` читался «остановлено»: пауза записывала живой прогон
 * остановленным (продолжение потом подняло бы вторую копию той же сессии), а
 * счётчик «остановлено прогонов» врал человеку.
 *
 * Настоящие здесь процесс, `killPidTree`, реестр, пауза дерева, маршруты
 * группы; подменён только снимок процессов — граница, которая отказала.
 */

class Ledger implements RunLedgerSink {
  readonly entries = new Map<string, RunLedgerEntry>();
  read(): RunLedgerEntry[] {
    return [...this.entries.values()];
  }
  upsert(entry: RunLedgerEntry): void {
    this.entries.set(entry.key, entry);
  }
  remove(key: string): void {
    this.entries.delete(key);
  }
}

let child: ChildProcess | undefined;
let registry: ChatRunRegistry | undefined;
let root = '';

afterEach(() => {
  registry?.stopAll();
  if (child?.pid && isPidAlive(child.pid)) child.kill('SIGKILL');
  child = undefined;
  registry = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

/** Живой процесс, усыновлённый реестром; снимка процессов нет — стоп не подтвердить. */
function adoptUnverifiable(): { pid: number; registry: ChatRunRegistry } {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  const entry: RunLedgerEntry = {
    key: 'new-stop',
    sessionId: 'sess-stop',
    projectPath: '/proj',
    cwd: '/proj',
    pid,
    startedAt: Date.now(),
  };
  const ledger = new Ledger();
  ledger.upsert(entry);
  const created = new ChatRunRegistry(() => {
    throw new Error('усыновление не запускает CLI');
  });
  registry = created;
  created.setLedger(ledger);
  const spawnedAt = Date.now();
  expect(
    created.adopt(entry, {
      pollMs: 20,
      kill: (target) =>
        killPidTree(target, { spawnedAt }, { platform: 'win32', readTable: () => undefined }),
    }),
  ).toBe(true);
  return { pid, registry: created };
}

describe('внутренние остановки при неподтверждённом стопе (F-145)', { timeout: 20_000 }, () => {
  it('реестр: stop() отдаёт исход, а не «да» — unconfirmed не читается остановкой', () => {
    const { pid, registry: runs } = adoptUnverifiable();
    expect(runs.stop('sess-stop')).toBe('unconfirmed');
    expect(isPidAlive(pid)).toBe(true);
    expect(runs.isRunning('new-stop')).toBe(true);
    expect(runs.stop('nobody')).toBe('absent');
  });

  it('пауза дерева: живой прогон не записан остановленным и назван человеку', () => {
    const { pid, registry: runs } = adoptUnverifiable();
    const records = new Map<string, TreePauseRecord>();
    const pause = new TreePause({
      links: () => ({ 'new-stop': { parentChatId: 'parent' } }) as never,
      runs: createTreeRuns({
        registry: runs,
        chats: {} as never,
        appDataDir: () => tmpdir(),
        provider: () => undefined,
        models: () => [],
      }),
      store: {
        get: (key) => records.get(key),
        all: () => Object.fromEntries(records),
        set: (record) => void records.set(record.root, record),
        clear: (key) => void records.delete(key),
      },
    });

    const result = pause.pause('new-stop');

    expect(result).toMatchObject({ root: 'parent', stopped: 0, unconfirmed: 1, chats: 0 });
    // В записи паузы его нет: «Продолжить» подняло бы по нему вторую копию той
    // же сессии рядом с живой.
    expect(records.get('parent')?.chats).toEqual({});
    expect(isPidAlive(pid)).toBe(true);
    expect(runs.isRunning('new-stop')).toBe(true);
  });

  it('пауза и отмена группы: «остановлено» не считает живой прогон', async () => {
    adoptUnverifiable();
    root = mkdtempSync(join(tmpdir(), 'cc-split-unconfirmed-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    const ctx = {
      store: new AppStore(join(root, 'data')),
      location: { paths: { root, appData: join(root, 'data') } },
    } as unknown as ServerContext;
    const conveyor = {
      pause: () => ({ chatIds: ['new-stop'] }),
      cancel: () => ({ chatIds: ['new-stop'], cancelled: 1, paths: [] }),
    } as unknown as SplitConveyor;
    const app = Fastify();
    try {
      registerSplitControlRoutes(app, ctx, {
        runs: registry as ChatRunRegistry,
        providerChats: {} as SplitLaunchDeps['providerChats'],
        conveyor,
      });
      await app.ready();

      const paused = await app.inject({
        method: 'POST',
        url: '/api/chat/split/parent/pause',
        payload: { index: 0 },
      });
      expect(paused.statusCode).toBe(200);
      expect(paused.json<SplitGroupPaused>()).toEqual({ index: 0, stopped: 0, unconfirmed: 1 });

      const cancelled = await app.inject({
        method: 'POST',
        url: '/api/chat/split/parent/cancel',
        payload: {},
      });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json<SplitPlanCancelled>()).toMatchObject({ stopped: 0, unconfirmed: 1 });
      expect(registry?.isRunning('new-stop')).toBe(true);
    } finally {
      await app.close();
    }
  });
});
