import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@agentdeck/contracts';
import { SPLIT_TICKET_TAG } from '@agentdeck/contracts/split-tickets';
import type { StreamState } from '@shared/lib/chat-stream';
import { ChatMessages } from './ChatMessages';
import type { ChatMessagesProps } from './ChatMessages.types';

/**
 * Блок тикета группы (95b) в ленте. Сервер вынимает его в запись группы, хаб
 * показывает списком «Предложить тикет», а сам ответ агента хранится как есть —
 * и без чистки в пузыре стоял сырой тег с полями. Проверяется разметка ленты
 * целиком, а не правило отдельно.
 */

const TICKET = [
  `<${SPLIT_TICKET_TAG}>`,
  'title: Кнопка съезжает',
  'where: src/Foo.tsx:12',
  'why: перекрывает поле',
  `</${SPLIT_TICKET_TAG}>`,
].join('\n');

function render(messages: ChatMessage[], streamText = ''): string {
  const stream: StreamState = {
    text: streamText,
    thinking: '',
    tools: [],
    isRunning: Boolean(streamText),
  };
  const props = { messages, stream, isLoading: false } as unknown as ChatMessagesProps;
  return renderToStaticMarkup(<ChatMessages {...props} />);
}

const answer = (text: string): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: '2026-09-25T00:00:00Z',
});

describe('лента — блок тикета группы не показывается', () => {
  it('в истории: тега и полей нет, отчёт вокруг остаётся', () => {
    const html = render([answer(`Отчёт готов.\n\n${TICKET}\n\nКонец.`)]);

    expect(html).not.toContain(SPLIT_TICKET_TAG);
    expect(html).not.toContain('Кнопка съезжает');
    expect(html).toContain('Отчёт готов.');
    expect(html).toContain('Конец.');
  });

  it('в живом потоке: закрытый блок прячется', () => {
    const html = render([], `Отчёт.\n\n${TICKET}\n\nДальше.`);

    expect(html).not.toContain('Кнопка съезжает');
    expect(html).toContain('Дальше.');
  });

  it('в живом потоке: недописанный блок прячется вместе с хвостом', () => {
    const html = render([], `Отчёт.\n\n<${SPLIT_TICKET_TAG}>\ntitle: Кнопка съезжает\nwhe`);

    expect(html).not.toContain(SPLIT_TICKET_TAG);
    expect(html).not.toContain('Кнопка съезжает');
    expect(html).toContain('Отчёт.');
  });

  // Итоговое ревью 25.09 (m10): человек, приславший блок (например, описывая
  // формат), видит свой текст как есть — прятать чужое сообщение незачем.
  it('в сообщении человека блок не вырезается', () => {
    const html = render([{ ...answer(`Формат:\n\n${TICKET}`), id: 'u1', role: 'user' }]);

    expect(html).toContain('Кнопка съезжает');
  });
});
