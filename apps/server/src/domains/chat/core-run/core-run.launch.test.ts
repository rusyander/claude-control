import { describe, expect, it } from 'vitest';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { ChatEvent } from '../chat-events.ts';
import { stubCorePort } from './__fixtures__/stub-core-port.ts';
import { CoreChatRun } from './core-run.ts';
import type { CoreChatBook, CoreChatEntry, CoreChatPort } from './core-run.types.ts';

/**
 * Запуск хода чата не зависит от того, отвечает ли оценка уже готовой задачей. Ядро отказывает
 * `launch` в `estimating` (`state-conflict`, W3-D F2 на проходе по стенду); чат на месте выходит из
 * оценки в самом ответе, и запуск сразу работал только поэтому. Здесь ядро на границе порта держит
 * задачу в `estimating` несколько опросов: запуск обязан дождаться выхода, а не упасть. Живой
 * путь против настоящего ядра — `core-run.launch.live.integration.test.ts`.
 */

function memoryBook(): CoreChatBook {
  const entries = new Map<string, CoreChatEntry>();
  return {
    get: (id) => entries.get(id),
    cliOf: (id) => entries.get(id)?.cli,
    set: (id, entry) => void entries.set(id, entry),
    forget: (id) => void entries.delete(id),
  };
}

/** Ядро, у которого оценка идёт ещё `polls` опросов вида: `launch` в это время — `state-conflict`. */
function estimatingCore(polls: number, ends?: 'failed') {
  const stub = stubCorePort();
  let left = polls;
  const views: string[] = [];
  const port: CoreChatPort = {
    ...stub.port,
    async view(taskId) {
      const view = await stub.port.view(taskId);
      if (!view) return view;
      const state = left > 0 ? 'estimating' : 'awaiting-launch';
      if (left > 0) left -= 1;
      views.push(state);
      const ended = left === 0 && ends ? ends : null;
      return { ...view, state, ended } as TaskView;
    },
    async command(taskId, kind, fields) {
      if (kind === 'launch' && left > 0) {
        stub.calls.push({ taskId, kind, fields });
        return {
          cmdId: 'c',
          status: 'rejected',
          code: 'state-conflict',
          reason: 'launch not allowed in estimating',
          seq: 0,
        } as CommandOutcome;
      }
      return stub.port.command(taskId, kind, fields);
    },
  };
  return { stub, port, views };
}

async function startTurn(port: CoreChatPort, finish: () => void): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const run = new CoreChatRun({ port, book: memoryBook(), pollMs: 1, waitMs: 5_000 });
  const started = run.start({ prompt: 'привет', cwd: 'C:/work/proj' }, (e) => {
    events.push(e);
    if (e.kind === 'session') finish();
  });
  await started;
  return events;
}

describe('core chat launch waits until the estimate leaves estimating', () => {
  it('the task stays in estimating for three polls: launch goes once, after it, and the turn runs', async () => {
    const core = estimatingCore(3);
    const events = await startTurn(core.port, () => core.stub.finish());
    expect(core.views.slice(0, 4)).toEqual([
      'estimating',
      'estimating',
      'estimating',
      'awaiting-launch',
    ]);
    expect(core.stub.calls.filter((c) => c.kind === 'launch')).toHaveLength(1);
    expect(core.stub.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch']);
    expect(events.map((e) => e.kind)).toContain('done');
  });

  it('the estimate ends the task instead: the turn fails naming the end, launch never sent', async () => {
    const core = estimatingCore(1, 'failed');
    await expect(startTurn(core.port, () => core.stub.finish())).rejects.toThrow(/failed/);
    expect(core.stub.calls.filter((c) => c.kind === 'launch')).toEqual([]);
  });
});
