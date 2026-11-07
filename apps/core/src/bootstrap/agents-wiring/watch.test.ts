import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { linesAfter } from '../../journal/read-view.ts';
import { foldAgents } from '../../journal/reduce/agents-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ProcessIdentity } from '../../platform/process-identity.ts';
import { seedLiveSession } from './__fixtures__/seed.ts';
import { createBgWatch } from './watch.ts';

/**
 * Личность процесса фоновой работы (этап 11, P148, P12): сторож снимает только процесс, чью
 * личность (pid + время старта) он закрепил, пока работа была молодой и владелец жив. Номер,
 * который ОС отдала другому процессу после ухода работы, — чужой: закрепить его позже значило бы
 * убить чужой процесс на конце владельца. Подменены только проба ОС и снос — сторож, журнал и
 * свёртка настоящие.
 */

const HOST: ProcessIdentity = { pid: 7001, start: 'host-start' };
const BG_PID = 7002;
const FOREIGN: ProcessIdentity = { pid: BG_PID, start: 'foreign-start' };

interface World {
  task: LiveTask;
  sessionId: string;
  stopped: ProcessIdentity[];
  /** Что ОС отвечает о номере работы на каждом обходе. */
  table: { bg: ProcessIdentity | null };
  fold(): ReturnType<typeof foldAgents>;
  sweep(): Promise<void>;
}

async function world(startedAt: number, before?: (task: LiveTask) => void): Promise<World> {
  const registry = createTaskRegistry(join(tempDir('bg-watch-'), 'tasks'), deps());
  const task = await registry.create(CREATED);
  const ids = seedLiveSession(task, HOST);
  before?.(task);
  task.append({
    kind: 'bg.started',
    actor: 'core',
    sessionId: ids.sessionId,
    data: {
      itemId: 'bash_x',
      kind: 'server',
      excerpt: 'node server.js',
      ownerChain: { ...ids, toolUseId: 'toolu_bash', parentToolUseId: null },
      pid: BG_PID,
      startedAt,
    },
  } as never);
  const stopped: ProcessIdentity[] = [];
  const table: World['table'] = { bg: null };
  const watch = createBgWatch({
    liveness: {
      isAlive: async (id) =>
        id.pid === HOST.pid ? 'alive' : table.bg && table.bg.start === id.start ? 'alive' : 'dead',
      identityOf: async (pid) =>
        pid === BG_PID && table.bg ? { value: table.bg } : { absent: true },
    },
    note: () => undefined,
    now: () => 0,
    release: {
      stopProcess: async (id) => {
        stopped.push(id);
        return { verified: `${id.pid} gone` };
      },
    },
  });
  const fold = () => foldAgents(task.taskId, linesAfter(task.dir, task.taskId, 0));
  return {
    task,
    sessionId: ids.sessionId,
    stopped,
    table,
    fold,
    sweep: () => watch.sweepTask(task, fold()),
  };
}

const endSession = (w: World): void => {
  w.task.append({
    kind: 'session.transition',
    actor: 'core',
    sessionId: w.sessionId,
    data: { sessionId: w.sessionId, event: 'exited', from: 'live', to: 'ended' },
  });
};

const orphanDetail = (w: World): string | undefined => {
  const line = linesAfter(w.task.dir, w.task.taskId, 0).find(
    (l): l is JournalLine<'signal'> =>
      l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === 'bg-orphan',
  );
  return line?.data.detail;
};

describe('stage 11 background watch pins only the process it saw young (P148, P12)', () => {
  it('the process was already gone when first looked at; its pid reused later is NOT pinned and NOT killed', async () => {
    const w = await world(Date.now());
    // Обход 1: владелец жив, номера работы в таблице нет — работа уже ушла.
    await w.sweep();
    // Обход 2: тот же номер занял чужой процесс.
    w.table.bg = FOREIGN;
    await w.sweep();
    endSession(w);
    await w.sweep();
    expect(w.stopped).toEqual([]);
    expect(orphanDetail(w)).toContain('NOT reaped');
  });

  it('an item first seen long after its start (core restart) is not pinned: named, never killed', async () => {
    const w = await world(Date.now() - 10 * 60_000);
    w.table.bg = FOREIGN;
    await w.sweep();
    endSession(w);
    await w.sweep();
    expect(w.stopped).toEqual([]);
    expect(orphanDetail(w)).toContain('NOT reaped');
  });

  it('a process row journaled BEFORE the item started is another process: it is not the item’s pin', async () => {
    // Процесс ядра той же задачи, записанный раньше работы, теперь держит номер работы.
    const coreOwn: ProcessIdentity = { pid: BG_PID, start: 'core-own-start' };
    const w = await world(Date.now() - 10 * 60_000, (task) => {
      task.append({
        kind: 'resource.created',
        actor: 'core',
        data: {
          rid: '01900000-0000-7000-8000-00000000aaaa',
          kind: 'process',
          owner: 'core',
          release: 'task-end',
          ref: JSON.stringify(coreOwn),
        },
      });
    });
    w.table.bg = coreOwn;
    await w.sweep();
    endSession(w);
    await w.sweep();
    expect(w.stopped).toEqual([]);
    expect(orphanDetail(w)).toContain('NOT reaped');
  });

  it('near-miss: a young item seen alive is pinned and reaped through the resource release', async () => {
    const own: ProcessIdentity = { pid: BG_PID, start: 'own-start' };
    const w = await world(Date.now());
    w.table.bg = own;
    await w.sweep();
    endSession(w);
    await w.sweep();
    expect(w.stopped).toEqual([own]);
    expect(orphanDetail(w)).toContain('reaped through resource');
  });
});
