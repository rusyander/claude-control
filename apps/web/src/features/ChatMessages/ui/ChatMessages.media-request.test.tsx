import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@agentdeck/contracts';
import { deckBlockRequest } from '@agentdeck/contracts/media-block';
import type { StreamState } from '@shared/lib/chat-stream';
import { ChatMessages } from './ChatMessages';
import type { ChatMessagesProps } from './ChatMessages.types';

/**
 * Просьба режима «Презентация» в ленте (живой прогон 26.09.2026): правила из
 * каталога стояли простынёй в пузыре человека. Сверху — слова человека, правила
 * свёрнуты, но не выброшены: агент получил именно их.
 */
function render(messages: ChatMessage[]): string {
  const stream: StreamState = { text: '', thinking: '', tools: [], isRunning: false };
  const props = { messages, stream, isLoading: false } as unknown as ChatMessagesProps;
  return renderToStaticMarkup(<ChatMessages {...props} />);
}

const user = (text: string): ChatMessage => ({
  id: 'u1',
  role: 'user',
  blocks: [{ type: 'text', text }],
  timestamp: '2026-09-26T00:00:00Z',
});

describe('лента — просьба режима', () => {
  it('тема видна сразу, правила свёрнуты под раскрытием', () => {
    const html = render([user(deckBlockRequest('Правило колоды: без воды.', 'История кофе'))]);
    expect(html).toContain('data-media-request="deck"');
    expect(html).toMatch(/<strong>[^<]+:<\/strong> История кофе/);
    const rules = html.indexOf('<details');
    expect(rules).toBeGreaterThan(-1);
    expect(html.indexOf('Правило колоды')).toBeGreaterThan(rules);
  });

  it('обычная реплика человека показывается как есть', () => {
    const html = render([user('Тема: кофе')]);
    expect(html).not.toContain('data-media-request');
    expect(html).toContain('Тема: кофе');
  });
});
