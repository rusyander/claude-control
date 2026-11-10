import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import type { AskView } from '@agentdeck/contracts/core/task-view';
import { coreWaitingCards, liveTaskIds, type WaitingTaskView } from './coreWaiting';

/**
 * «Ждёт вас» во «Вопросах» телефона (этап 12, P176): задача ядра там, только если её держит
 * блокирующий вопрос — открытый и без действия по умолчанию (`contracts/core/waiting`, та же
 * функция, что у доски панели и push). Настоящие: функция раздела и общий суд `askWaits`.
 */

const T1 = '019a0000-0000-7000-8000-000000000001';
const T2 = '019a0000-0000-7000-8000-000000000002';
const T3 = '019a0000-0000-7000-8000-000000000003';
const T4 = '019a0000-0000-7000-8000-000000000004';

const task = (taskId: string, over: Partial<TaskListItem> = {}): TaskListItem => ({
  taskId,
  live: true,
  seq: 10,
  state: 'running' as TaskListItem['state'],
  ended: null,
  title: `Задача ${taskId.slice(-1)}`,
  attention: null,
  ...over,
});

const ask = (askId: string, over: Partial<AskView> = {}): AskView =>
  ({
    askId,
    state: 'open',
    point: 4,
    source: 'login',
    dedupe: null,
    stepId: null,
    lateAnswer: false,
    answer: null,
    defaultAction: null,
    ...over,
  }) as AskView;

const views = (entries: [string, AskView[]][]): Map<string, WaitingTaskView> =>
  new Map(entries.map(([taskId, asks]) => [taskId, { asks }]));

describe('core «waiting for you» on the phone: only blocking asks', () => {
  it('a blocking open ask lists the task with its count and first question; a default-action ask does not', () => {
    const cards = coreWaitingCards(
      [task(T1), task(T2)],
      views([
        [
          T1,
          [
            ask('a1', { question: '  Войти заново?  ' }),
            ask('a2', { defaultAction: 'skip', question: 'Пропустить?' }),
            ask('a3', { question: 'Второй' }),
          ],
        ],
        [T2, [ask('b1', { defaultAction: 'continue', question: 'Идёт дальше сам' })]],
      ]),
    );
    expect(cards).toEqual([{ taskId: T1, title: 'Задача 1', count: 2, question: 'Войти заново?' }]);
  });

  it('answered, expired and pre-12 asks (no defaultAction field) do not hold a task; ended tasks are skipped', () => {
    const withoutField = ask('c1');
    delete (withoutField as { defaultAction?: unknown }).defaultAction;
    const cards = coreWaitingCards(
      [task(T1), task(T2), task(T3, { live: false, ended: 'done' }), task(T4, { title: '  ' })],
      views([
        [T1, [ask('a1', { state: 'answered' }), ask('a2', { state: 'expired' })]],
        [T2, [withoutField]],
        [T3, [ask('d1')]],
        [T4, [ask('e1')]],
      ]),
    );
    expect(cards).toEqual([{ taskId: T4, title: null, count: 1, question: '' }]);
  });

  it('a chat task is not listed: its blocking permission ask is already the chat card above', () => {
    // Чат идёт ядром (сценарий `chat`): вопрос права держит задачу, но телефон показывает его
    // карточкой чата (`chat-inbox` несёт `core`) — второй раз в «Ждёт вас» он задвоил бы и значок.
    const chat: WaitingTaskView = {
      asks: [ask('p1', { source: 'permit', point: 5, question: 'Bash: npm test' })],
      scenario: { ref: { id: 'chat', version: 1 } },
    };
    const work: WaitingTaskView = {
      asks: [ask('w1', { question: 'Войти заново?' })],
      scenario: { ref: { id: 'feature', version: 1 } },
    };
    const cards = coreWaitingCards(
      [task(T1), task(T2)],
      new Map([
        [T1, chat],
        [T2, work],
      ]),
    );
    expect(cards.map((card) => card.taskId)).toEqual([T2]);
  });

  it('only live, not ended tasks are fetched; a task whose view has not arrived is not listed yet', () => {
    const tasks = [task(T1), task(T2, { live: false }), task(T3, { ended: 'failed' })];
    expect(liveTaskIds(tasks)).toEqual([T1]);
    expect(coreWaitingCards(tasks, new Map())).toEqual([]);
  });
});
