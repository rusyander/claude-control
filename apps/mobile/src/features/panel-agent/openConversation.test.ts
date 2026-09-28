import { describe, expect, it } from 'vitest';
import { EMPTY_CONVERSATION } from '@agentdeck/contracts/panel-agent-feed';
import { openConversation } from './openConversation';

/**
 * Разговор из истории не загрузился: `open()` отклонялся, вызов без `catch`
 * давал необработанный отказ и тихое «ничего не произошло» (F-369). Теперь
 * открытие всегда даёт состояние — с причиной строкой ошибки.
 */
describe('openConversation', () => {
  const failed = (message: string) => `не открылся: ${message}`;

  it('сбой загрузки — пустой разговор со строкой ошибки, а не отказ', async () => {
    const state = await openConversation({
      load: () => Promise.reject(new Error('сеть недоступна')),
      sealNote: undefined,
      failed,
    });
    expect(state.messages).toEqual(EMPTY_CONVERSATION.messages);
    expect(JSON.stringify(state)).toContain('не открылся: сеть недоступна');
  });
});
