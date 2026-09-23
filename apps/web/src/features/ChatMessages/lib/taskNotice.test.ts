import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { taskNoticesOf } from './taskNotice';

/**
 * Уведомление CLI о фоновой команде — не реплика человека. Текст ниже — ровно
 * то, что claude 2.1.280 записал в транскрипт живой проверки 23.09.2026.
 */
const NOTICE =
  '<task-notification>\n<task-id>b7fvhhvqd</task-id>\n<tool-use-id>toolu_01Par6</tool-use-id>\n' +
  '<output-file>C:\\tmp\\tasks\\b7fvhhvqd.output</output-file>\n<status>completed</status>\n' +
  '<summary>Background command "Background sleep test for 25 seconds, then write marker file" ' +
  'completed (exit code 0)</summary>\n</task-notification>';

const user = (text: string): ChatMessage => ({
  id: 'm',
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: '',
});

describe('taskNoticesOf', () => {
  it('разбирает уведомление CLI в статус и сводку', () => {
    expect(taskNoticesOf(user(NOTICE))).toEqual([
      {
        status: 'completed',
        summary:
          'Background command "Background sleep test for 25 seconds, then write marker file" ' +
          'completed (exit code 0)',
      },
    ]);
  });

  it('два уведомления одной репликой — оба, хвост для модели отброшен', () => {
    const failed = NOTICE.replace('completed</status>', 'failed</status>');
    const notices = taskNoticesOf(user(`${NOTICE}\n${failed}\nRead the output file.`));
    expect(notices?.map((notice) => notice.status)).toEqual(['completed', 'failed']);
  });

  it('реплика человека остаётся репликой, даже с тегом внутри', () => {
    expect(taskNoticesOf(user('Смотри, что пришло:\n' + NOTICE))).toBeUndefined();
    expect(taskNoticesOf({ ...user(NOTICE), role: 'assistant' })).toBeUndefined();
    expect(
      taskNoticesOf({
        ...user(NOTICE),
        blocks: [
          { type: 'text', text: NOTICE },
          { type: 'image', source: 'x' },
        ],
      }),
    ).toBeUndefined();
  });
});
