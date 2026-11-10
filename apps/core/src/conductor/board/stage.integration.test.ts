import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { startBoardStand, type BoardStand } from '../../bootstrap/__fixtures__/board-stand.ts';
import {
  ask,
  cancelled,
  go,
  newTask,
  running,
  session,
  step,
  unit,
} from './__fixtures__/task-lines.ts';

/**
 * Колонка карточки по фактам журнала (этап 12, B2; P152, P153): настоящие задачи в реестре
 * стенда, настоящие строки журнала через `LiveTask.append`, вид доски — через `GET /v1/board`.
 * Полный прогон задачи на заглушке модели — сквозной QA закрывающего прохода волны (W1-D).
 */

let b: BoardStand;
beforeAll(async () => {
  b = await startBoardStand();
  await b.setBoard({ paused: true });
});
afterAll(async () => {
  await b.close();
});

const task = (over: Partial<JournalDataV1['task.created']> = {}): Promise<LiveTask> =>
  newTask(b.s.registry, over);

async function card(t: LiveTask): Promise<BoardCard | undefined> {
  return (await b.board()).cards.find((c) => c.taskId === t.state.taskId);
}

describe('board stage = journal facts (B2, P152, P153)', () => {
  it('draft, estimating and awaiting launch stand in triage; a running step decides by its kind', async () => {
    const t = await task();
    expect((await card(t))?.column).toBe('triage');
    running(t);
    const u = unit(t);
    step(t, u, 'intake', 'done');
    step(t, u, 'work');
    expect((await card(t))?.column).toBe('work');
  });

  it('review, check and publish steps map to review, check and ready', async () => {
    for (const [kind, column] of [
      ['review', 'review'],
      ['check', 'check'],
      ['final-gate', 'check'],
      ['publish', 'ready'],
    ] as const) {
      const t = await task();
      running(t);
      step(t, unit(t), kind);
      expect([kind, (await card(t))?.column]).toEqual([kind, column]);
    }
  });

  it('the slowest live stage decides: one unit in work, another in review → work', async () => {
    const t = await task();
    running(t);
    const split = newId();
    step(t, unit(t, split), 'review');
    step(t, unit(t, split), 'work');
    const c = await card(t);
    expect(c?.column).toBe('work');
    expect(c?.units).toEqual({ done: 0, total: 2 });
  });

  it('a non-blocking question leaves the card in its column with a badge; a blocking one moves it to waiting', async () => {
    const t = await task();
    running(t);
    step(t, unit(t), 'review');
    ask(t, 'continue');
    let c = await card(t);
    expect(c).toMatchObject({ column: 'review', waiting: false, questions: 1 });
    ask(t, null);
    c = await card(t);
    expect(c).toMatchObject({ column: 'waiting', waiting: true, questions: 1 });
  });

  it('ended: no MR → closed; MR open → mr with its title; MR merged at the forge → merged', async () => {
    const closed = await task();
    running(closed);
    cancelled(closed);
    expect((await card(closed))?.column).toBe('closed');

    const t = await task();
    running(t);
    const u = unit(t);
    t.append({
      kind: 'publish.mr',
      actor: 'core',
      unitId: u,
      data: {
        unitId: u,
        forge: 'gitlab',
        mrId: '77',
        mrIid: 7,
        url: 'https://forge.example.com/g/p/-/merge_requests/7',
        sourceBranch: 'b',
        actionId: newId(),
        title: 'Export button on the report page',
      },
    });
    let c = await card(t);
    expect(c?.column).toBe('mr');
    expect(c?.mr).toEqual({
      url: 'https://forge.example.com/g/p/-/merge_requests/7',
      iid: 7,
      title: 'Export button on the report page',
      state: 'opened',
    });
    t.append({
      kind: 'publish.mr-state',
      actor: 'core',
      unitId: u,
      data: { unitId: u, state: 'merged', at: 1 },
    });
    go(t, 'publish', 'running', 'publishing');
    go(t, 'published', 'publishing', 'done');
    t.append({ kind: 'task.ended', actor: 'core', data: { outcome: 'done' } });
    c = await card(t);
    expect(c?.column).toBe('merged');
    expect(c?.mr?.state).toBe('merged');
  });

  it('a chat task is no card; a takeover and a changed stop show on the card', async () => {
    const chat = await task({ scenario: { id: 'chat', version: 1 } });
    expect(await card(chat)).toBeUndefined();
    const t = await task();
    running(t);
    const u = unit(t);
    step(t, u, 'work');
    t.append({
      kind: 'task.takeover',
      actor: 'human:panel',
      data: { unitId: u, copy: '/copies/u' },
    });
    t.append({ kind: 'task.stop', actor: 'human:panel', data: { stop: 'end' } });
    const c = await card(t);
    expect(c?.takeover).toEqual({ unitId: u, copy: '/copies/u' });
    expect(c?.stop).toBe('end');
    expect(c?.moves).toEqual([]);
  });

  it('a takeover with its chat carries the chat task id on the card (the panel opens that chat)', async () => {
    const t = await task();
    running(t);
    const u = unit(t);
    step(t, u, 'work');
    const chatTaskId = newId();
    t.append({
      kind: 'task.takeover',
      actor: 'human:panel',
      data: { unitId: u, copy: '/copies/u', chatTaskId },
    });
    expect((await card(t))?.takeover).toEqual({ unitId: u, copy: '/copies/u', chatTaskId });
  });

  it('in work counts a running task, not one that waits with no live session, not a takeover (P155)', async () => {
    const before = (await b.board()).limits.inWork.used;
    const busy = await task();
    running(busy);
    step(busy, unit(busy), 'work');
    expect((await b.board()).limits.inWork.used).toBe(before + 1);
    const waits = await task();
    running(waits);
    step(waits, unit(waits), 'work');
    ask(waits, null);
    // Ждёт человека и модель молчит — место свободно.
    expect((await b.board()).limits.inWork.used).toBe(before + 1);
    session(waits);
    // Вопрос открыт, но сеанс жив — место занято.
    expect((await b.board()).limits.inWork.used).toBe(before + 2);
    const taken = await task();
    running(taken);
    const u = unit(taken);
    step(taken, u, 'work');
    taken.append({ kind: 'task.takeover', actor: 'human:panel', data: { unitId: u, copy: '/c' } });
    expect((await b.board()).limits.inWork.used).toBe(before + 2);
  });
});
