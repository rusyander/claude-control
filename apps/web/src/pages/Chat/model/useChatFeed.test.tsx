import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@agentdeck/contracts';
import type { AgentRun } from '@shared/lib/agent-runs';
import type { StreamState } from '@shared/lib/chat-stream';
import { useChatFeed, type ChatFeedInput } from './useChatFeed';

/**
 * Лента `ChatPage`, вынесенная в хук: проверяется, что каждый хук сущностей
 * получает то же, что получал на странице (окно, id прогресса, флаг автообновления),
 * и что текущий ход прячется из истории только при показанном потоке.
 * Хуки сущностей подменены — они ходят в сеть; сам хук и `withoutLiveTurn` настоящие.
 */

const calls = vi.hoisted(() => ({
  messages: [] as unknown[][],
  refresh: [] as unknown[][],
  progress: [] as unknown[][],
  pane: [] as unknown[][],
  hint: [] as unknown[][],
  history: [] as ChatMessage[],
}));

vi.mock('@entities/Chat', () => ({
  CHAT_PAGE_SIZE: 400,
  useChatMessages: (...args: unknown[]) => {
    calls.messages.push(args);
    return { data: { messages: calls.history, hasMore: false } };
  },
  useChatAutoRefresh: (...args: unknown[]) => {
    calls.refresh.push(args);
  },
  useChatProgress: (...args: unknown[]) => {
    calls.progress.push(args);
    return { data: undefined };
  },
}));
vi.mock('@entities/AgentTree', () => ({
  useAgentPane: (...args: unknown[]) => {
    calls.pane.push(args);
    return undefined;
  },
}));
vi.mock('@entities/Platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@entities/Platform')>()),
  useTurnToolHint: (...args: unknown[]) => {
    calls.hint.push(args);
    return undefined;
  },
}));
vi.mock('@features/ChatMessages', () => ({
  // Отлистанное окно помнится по id разговора — у `chat-1` оно шире страницы.
  recallFeedLimit: (id: string | undefined) => (id === 'chat-1' ? 800 : undefined),
  rememberFeedLimit: () => {},
}));

const message = (role: 'user' | 'assistant', timestamp: string): ChatMessage =>
  ({ id: `${role}-${timestamp}`, role, timestamp, blocks: [] }) as unknown as ChatMessage;

const stream = (over: Partial<StreamState> = {}): StreamState => ({
  text: '',
  thinking: '',
  tools: [],
  isRunning: false,
  ...over,
});

function run(input: Partial<Omit<ChatFeedInput, 'run'>> & { run?: Partial<AgentRun> }) {
  let result: ReturnType<typeof useChatFeed> | undefined;
  function Probe() {
    result = useChatFeed({
      activeChatId: 'chat-1',
      consumer: 'chat',
      stream: stream(),
      isRunning: false,
      ...input,
      run: { startedAt: undefined, ...input.run } as AgentRun,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!result) throw new Error('hook did not run');
  return result;
}

beforeEach(() => {
  for (const list of [calls.messages, calls.refresh, calls.progress, calls.pane, calls.hint]) {
    list.length = 0;
  }
  calls.history = [];
});

describe('useChatFeed', () => {
  it('читает историю окном разговора и отдаёт её целиком, пока потока нет', () => {
    calls.history = [
      message('user', '2026-10-26T10:00:00Z'),
      message('assistant', '2026-10-26T10:00:05Z'),
    ];
    const feed = run({ run: { startedAt: Date.parse('2026-10-26T10:00:01Z') } });
    expect(calls.messages[0]).toEqual(['chat-1', 800]);
    expect(feed.shownHistory).toBe(feed.messageList);
    expect(feed.shownHistory).toHaveLength(2);
  });

  it('при показанном потоке прячет ответы модели после старта прогона', () => {
    calls.history = [
      message('user', '2026-10-26T10:00:00Z'),
      message('assistant', '2026-10-26T10:00:05Z'),
    ];
    const feed = run({
      stream: stream({ isRunning: true }),
      isRunning: true,
      run: { startedAt: Date.parse('2026-10-26T10:00:01Z') },
    });
    expect(feed.shownHistory.map((item) => item.role)).toEqual(['user']);
  });

  it('ход слова «на ходу» (turnAt): ответ прошлого хода того же прогона — из истории, не прячется', () => {
    calls.history = [
      message('user', '2026-10-26T10:00:00Z'),
      message('assistant', '2026-10-26T10:00:05Z'),
      message('user', '2026-10-26T10:00:09Z'),
      message('assistant', '2026-10-26T10:00:12Z'),
    ];
    const feed = run({
      stream: stream({ isRunning: true }),
      isRunning: true,
      run: {
        startedAt: Date.parse('2026-10-26T10:00:01Z'),
        turnAt: Date.parse('2026-10-26T10:00:08Z'),
      },
    });
    expect(feed.shownHistory.map((item) => item.id)).toEqual([
      'user-2026-10-26T10:00:00Z',
      'assistant-2026-10-26T10:00:05Z',
      'user-2026-10-26T10:00:09Z',
    ]);
  });

  it('прогресс и ход субагента — по id разговора, у черновика — по сессии прогона', () => {
    run({ activeChatId: undefined, run: { sessionId: 'session-9' } });
    expect(calls.progress[0]).toEqual(['session-9', false]);
    expect(calls.pane[0]).toEqual(['session-9']);
    run({ isRunning: true });
    expect(calls.progress[1]).toEqual(['chat-1', true]);
  });

  it('автообновление ведёт оборванный или припаркованный прогон', () => {
    run({ run: { stalled: true } });
    run({ run: { parked: true } });
    run({});
    expect(calls.refresh.map((args) => args[2])).toEqual([true, true, false]);
  });

  // F-02: граница хода слова «на ходу» доходит до автообновления — оно перечитывает переписку.
  it('автообновлению отдана граница текущего хода прогона (turnAt)', () => {
    run({ isRunning: true, run: { turnAt: 5_000 } });
    run({ isRunning: true });
    expect(calls.refresh.map((args) => args[3])).toEqual([5_000, undefined]);
  });

  it('подсказка контура спрашивает маршрут тем же потребителем', () => {
    run({ consumer: 'groups', isRunning: true });
    expect(calls.hint[0]?.[0]).toBe('groups');
    expect(calls.hint[0]?.[2]).toBe(true);
  });
});
