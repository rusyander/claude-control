import { describe, it, expect } from 'vitest';
import type { Record } from './ChatRecords.ts';
import { lastAskedIn } from './chat-inbox.ts';

/**
 * Итог фонового субагента или команды CLI пишет в транскрипт репликой от
 * имени человека — строкой `<task-notification>…`. Настоящий claude 2.1.282
 * (замер 28.09 стабом модели) делает так посреди хода, пока вопрос агента ещё
 * висит: сводка считала уведомление ответом, и вопрос пропадал с телефона, а
 * на столе карточка ждала дальше (1b). Уведомление — не ответ.
 */

const ask: Record = {
  type: 'assistant',
  timestamp: '2026-09-28T07:00:00.000Z',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'q1',
        name: 'AskUserQuestion',
        input: { questions: [{ question: 'Which stack?', options: [{ label: 'A' }] }] },
      },
    ],
  },
};

const brokerRefusal: Record = {
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'q1',
        content: 'The answer comes as the next message',
        is_error: true,
      },
    ],
  } as Record['message'],
};

const NOTICE =
  '<task-notification>\n<task-id>a4da67df8d652183a</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n' +
  '<status>completed</status>\n<summary>Agent "Scan the repo" completed</summary>\n</task-notification>';

describe('lastAskedIn — уведомление CLI о фоновой задаче', () => {
  it('строка-уведомление вопрос не снимает', () => {
    const notice: Record = { type: 'user', message: { content: NOTICE } };
    expect(lastAskedIn([ask, brokerRefusal, notice])).toMatchObject({ toolUseId: 'q1' });
  });

  it('уведомление текстовым блоком тоже не снимает', () => {
    const notice: Record = {
      type: 'user',
      message: { content: [{ type: 'text', text: NOTICE }] } as Record['message'],
    };
    expect(lastAskedIn([ask, brokerRefusal, notice])).toMatchObject({ toolUseId: 'q1' });
  });

  it('человек, вставивший тег посреди своего текста, отвечает', () => {
    const human: Record = { type: 'user', message: { content: `A, see ${NOTICE}` } };
    expect(lastAskedIn([ask, brokerRefusal, human])).toBeUndefined();
  });

  it('ответ человека после уведомления вопрос снимает', () => {
    const notice: Record = { type: 'user', message: { content: NOTICE } };
    const human: Record = { type: 'user', message: { content: 'A' } };
    expect(lastAskedIn([ask, brokerRefusal, notice, human])).toBeUndefined();
  });
});
