import { describe, expect, it } from 'vitest';
import { chatTitleText, toBlocks, type Record } from './ChatRecords.ts';

/**
 * Ход `/chat`, доставленный ядром (этап 10, F2): CLI пишет в транскрипт текст отправки как есть —
 * метка платформы, «от человека», строка метки доставки, затем слова. Строки взяты из живого
 * транскрипта стенда `check-core-chat.mjs`.
 */
const DELIVERED = [
  '<!-- agentdeck:platform -->',
  'agentdeck-from: human',
  '[agentdeck · human-origin] Message from the human to this step:',
  'ход-9: запиши вне проекта',
].join('\n');

const user = (content: unknown): Record =>
  ({ type: 'user', message: { role: 'user', content } }) as Record;

describe('ChatRecords — a /chat turn delivered by the core', () => {
  it('the bubble shows only the human words, not the delivery header', () => {
    expect(toBlocks(user(DELIVERED))).toEqual([
      { type: 'text', text: 'ход-9: запиши вне проекта' },
    ]);
    expect(toBlocks(user([{ type: 'text', text: DELIVERED }]))).toEqual([
      { type: 'text', text: 'ход-9: запиши вне проекта' },
    ]);
  });

  it('a first turn delivered by the core names the chat by the human words', () => {
    expect(chatTitleText([user(DELIVERED)])).toBe('ход-9: запиши вне проекта');
  });

  it('header-like lines below the words of the human stay as written', () => {
    const own = 'это мои слова\n<!-- agentdeck:platform -->\nagentdeck-from: human';
    expect(toBlocks(user(own))).toEqual([{ type: 'text', text: own }]);
  });

  it('a model reply is never cut', () => {
    const reply = {
      type: 'assistant',
      message: { role: 'assistant', content: DELIVERED },
    } as Record;
    expect(toBlocks(reply)).toEqual([{ type: 'text', text: DELIVERED }]);
  });
});
