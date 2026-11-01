import { describe, expect, it } from 'vitest';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { SseEvent } from '@entities/CoreTask';
import { foldEvents } from '@features/CoreTimeline';
import { isRunning, openAsks, streamState, taskTitle } from './taskPage';

/** Страница ленты: какие вопросы ждут человека и что сказать о потоке. */

const A1 = '01900000-0000-7000-8000-000000000301';
const A2 = '01900000-0000-7000-8000-000000000302';

function ev(seq: number, kind: string, data: unknown) {
  const line = { v: 1, seq, at: seq, kind, data };
  return { id: String(seq), event: kind, data: JSON.stringify(line) } satisfies SseEvent;
}

const asked = (seq: number, askId: string) =>
  ev(seq, 'human.asked', { askId, point: 1, source: 'ask_human', question: 'q', options: [] });

describe('страница ленты задачи', () => {
  it('вопрос закрыт по виду ядра — карточки нет; вида нет — открыт, пока нет ответа в ленте', () => {
    const fold = foldEvents([ev(1, 'task.created', { title: 'T' }), asked(2, A1), asked(3, A2)]);
    expect(openAsks(fold, undefined).map((a) => a.ask.askId)).toEqual([A1, A2]);
    const view = {
      asks: [
        { askId: A1, state: 'answered' },
        { askId: A2, state: 'open' },
      ],
    };
    const open = openAsks(fold, view as unknown as TaskView);
    expect(open.map((a) => [a.ask.askId, a.state])).toEqual([[A2, 'open']]);
    const answered = foldEvents(
      [ev(4, 'human.answered', { askId: A2, answer: 'ok', channel: 'panel' })],
      fold,
    );
    expect(openAsks(answered, undefined).map((a) => a.ask.askId)).toEqual([A1]);
    expect(taskTitle(fold)).toBe('T');
    expect(taskTitle(foldEvents([]))).toBeNull();
  });

  it('отказ потока важнее обрыва', () => {
    expect(streamState(403, true)).toBe('refused');
    expect(streamState(undefined, true)).toBe('dropped');
    expect(streamState(undefined, false)).toBe('live');
  });
});

describe('список задач ядра — «Идёт»', () => {
  it('открытая в ядре, но закончившаяся задача не идёт; идёт только открытая и не закончившаяся', () => {
    expect(isRunning({ live: true, ended: null })).toBe(true);
    expect(isRunning({ live: true, ended: 'cancelled' })).toBe(false);
    expect(isRunning({ live: true, ended: 'done' })).toBe(false);
    expect(isRunning({ live: false, ended: null })).toBe(false);
  });
});
