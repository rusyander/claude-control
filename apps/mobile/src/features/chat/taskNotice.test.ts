import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agentdeck/contracts';
import { taskNoticesOf } from './taskNotice';

/** Итог фоновой задачи, записанный CLI от имени человека, — не реплика человека. */
const user = (text: string): ChatMessage =>
  ({ id: 'm', role: 'user', blocks: [{ type: 'text', text }] }) as ChatMessage;

const NOTICE =
  '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n' +
  '<status>completed</status>\n<summary>Agent "Scan the repo" completed</summary>\n</task-notification>';

describe('taskNoticesOf', () => {
  it('реплика-уведомление разбирается в статус и итог', () => {
    expect(taskNoticesOf(user(NOTICE))).toEqual([
      { status: 'completed', summary: 'Agent "Scan the repo" completed' },
    ]);
  });

  it('человек, вставивший тег посреди текста, остаётся человеком', () => {
    expect(taskNoticesOf(user(`look: ${NOTICE}`))).toBeUndefined();
    expect(taskNoticesOf({ ...user(NOTICE), role: 'assistant' } as ChatMessage)).toBeUndefined();
  });
});
