import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@agentdeck/contracts';
import type { StreamState } from '@shared/lib/chat-stream';
import { ChatMessages } from './ChatMessages';
import type { ChatMessagesProps } from './ChatMessages.types';

/**
 * Вопрос, закрытый автономией, чей выбор не разобрался (`autoPicks: []`, F-132):
 * сервер его уже закрыл, и лента обязана показать след автовыбора, а не форму
 * ответа с кнопками — клик по ней ушёл бы следующим сообщением в работающий ход.
 * Проверяется разметка ленты — и живого пузыря, и истории.
 */

const QUESTION = {
  questions: [
    {
      question: 'Какой путь?',
      header: 'Путь',
      options: [{ label: 'Быстрый' }, { label: 'Надёжный (Recommended)' }],
    },
  ],
};

function render(props: Partial<ChatMessagesProps>): string {
  const idle: StreamState = { text: '', thinking: '', tools: [], isRunning: false };
  const all = {
    messages: [],
    stream: idle,
    isLoading: false,
    ...props,
  } as unknown as ChatMessagesProps;
  return renderToStaticMarkup(<ChatMessages {...all} />);
}

const stream = (autoPicks?: { question: string; label: string }[]): StreamState => ({
  text: '',
  thinking: '',
  isRunning: true,
  tools: [
    {
      name: 'AskUserQuestion',
      input: JSON.stringify(QUESTION),
      id: 'q1',
      ...(autoPicks ? { autoPicks } : {}),
    },
  ],
});

const history = (autoPicks?: { question: string; label: string }[]): ChatMessage[] => [
  {
    id: 'm1',
    role: 'assistant',
    timestamp: '2026-09-28T10:00:00Z',
    blocks: [
      {
        type: 'tool',
        name: 'AskUserQuestion',
        input: QUESTION,
        id: 'q1',
        ...(autoPicks ? { autoPicks } : {}),
      },
    ],
  } as unknown as ChatMessage,
];

describe('вопрос, закрытый автовыбором без разобранного выбора', () => {
  it('живой пузырь: след автовыбора, без формы ответа', () => {
    const open = render({ stream: stream() });
    expect(open).toContain('Быстрый');
    expect(open).not.toContain('data-auto-pick');

    const closed = render({ stream: stream([]) });
    expect(closed).toContain('data-auto-pick="0"');
    expect(closed).not.toContain('Быстрый');
  });

  it('история: след автовыбора, без формы ответа', () => {
    const closed = render({ messages: history([]) });
    expect(closed).toContain('data-auto-pick="0"');
    expect(closed).not.toContain('Быстрый');

    const picked = render({
      messages: history([{ question: 'Какой путь?', label: 'Надёжный (Recommended)' }]),
    });
    expect(picked).toContain('data-auto-pick="1"');
  });
});
