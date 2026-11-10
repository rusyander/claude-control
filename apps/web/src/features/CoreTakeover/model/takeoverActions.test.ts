import type { BoardCard } from '@agentdeck/contracts/core/board';
import { describe, expect, it } from 'vitest';
import { takeoverActionsOf } from './takeoverActions';

/** Какие кнопки перехвата рисует карточка: ровно те, что ядро в этом состоянии примет. */

const TASK = '01900000-0000-7000-8000-000000000001';
const MR = { url: 'https://forge.example.com/g/p/-/merge_requests/4', iid: 4 };

const card = (extra: Partial<BoardCard>): BoardCard => ({
  kind: 'task',
  id: TASK,
  taskId: TASK,
  column: 'work',
  title: 't',
  state: 'running',
  stop: 'mr',
  waiting: false,
  questions: 0,
  takeover: null,
  moves: [],
  createdAt: 0,
  ...extra,
});

describe('действия перехвата на карточке', () => {
  it('идущая задача без MR: взять, доработать, сменить остановку; вернуть — нет', () => {
    expect(takeoverActionsOf(card({}))).toEqual({
      takeOver: true,
      handBack: false,
      rework: true,
      setStop: true,
    });
  });

  it('открытый перехват: только вернуть и остановка; взять второй раз и доработка словами — нет', () => {
    const open = card({ state: 'paused', takeover: { unitId: 'u', copy: 'c', chatTaskId: 'x' } });
    expect(takeoverActionsOf(open)).toEqual({
      takeOver: false,
      handBack: true,
      rework: false,
      setStop: true,
    });
  });

  it('готовая с открытым MR — доработка носителем; с влитым MR — ничего; MR есть — остановку не менять', () => {
    expect(takeoverActionsOf(card({ state: 'done', mr: { ...MR, state: 'opened' } }))).toEqual({
      takeOver: false,
      handBack: false,
      rework: true,
      setStop: false,
    });
    expect(takeoverActionsOf(card({ state: 'done', mr: { ...MR, state: 'merged' } }))).toEqual({
      takeOver: false,
      handBack: false,
      rework: false,
      setStop: false,
    });
    expect(takeoverActionsOf(card({ state: 'running', mr: { ...MR, state: 'opened' } }))).toEqual({
      takeOver: true,
      handBack: false,
      rework: true,
      setStop: false,
    });
  });

  it('запись без задачи и законченная задача без MR — ни одной кнопки', () => {
    const none = { takeOver: false, handBack: false, rework: false, setStop: false };
    expect(
      takeoverActionsOf(card({ kind: 'entry', taskId: undefined, entryId: TASK, state: 'queued' })),
    ).toEqual(none);
    expect(takeoverActionsOf(card({ state: 'failed' }))).toEqual(none);
  });
});
