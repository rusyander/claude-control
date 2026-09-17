/**
 * Лента разговора с агентом панели — одна для окна панели и телефона (А8).
 * Чистые функции без импортов-значений: телефон берёт модуль исходником через
 * Metro (`VALUE_MODULES`), сервер его не зовёт. Второй копии разбора кадров у
 * телефона нет — иначе два экрана одного разговора разошлись бы молча.
 */
import type { PanelAgentConversation, PanelAgentMessage, PanelAgentRunEvent } from './panel-agent';

/** Строка ленты окна: реплика, шаг агента или заметка панели. */
export interface FeedItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'tool-error' | 'notice' | 'error';
  text: string;
}

export interface ConversationState {
  /** Пусто, пока сервер не назвал разговор кадром `start`. */
  conversationId?: string;
  /** История для сервера: только реплики, без шагов и заметок. */
  messages: PanelAgentMessage[];
  feed: FeedItem[];
  running: boolean;
  /** Текст хода, уже показанный кадрами `text`, — чтобы `done` его не повторил. */
  turnText: string;
}

export const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  feed: [],
  running: false,
  turnText: '',
};

let seq = 0;
const nextId = (prefix: string): string => {
  seq += 1;
  return `${prefix}-${seq}`;
};

/** Человек отправил реплику: она сразу в ленте и в истории, ход начался. */
export function withUserMessage(state: ConversationState, text: string): ConversationState {
  return {
    ...state,
    messages: [...state.messages, { role: 'user', content: text }],
    feed: [...state.feed, { id: nextId('u'), kind: 'user', text }],
    running: true,
    turnText: '',
  };
}

/**
 * Кадр хода в состояние. `text` приходит целым блоком ответа (не дельтой), а
 * `done` несёт весь ответ ещё раз: показываем его, только если блоков не было —
 * иначе ответ стоял бы в ленте дважды. В историю для сервера ответ идёт из
 * `done`: это то, что сервер сохранил в файле разговора.
 */
export function applyRunEvent(
  state: ConversationState,
  event: PanelAgentRunEvent,
): ConversationState {
  switch (event.kind) {
    case 'start':
      return { ...state, conversationId: event.conversationId };
    case 'text':
      return {
        ...state,
        turnText: state.turnText + event.text,
        feed: [...state.feed, { id: nextId('a'), kind: 'assistant', text: event.text }],
      };
    case 'tool':
      return {
        ...state,
        feed: [...state.feed, { id: nextId('t'), kind: 'tool', text: event.name }],
      };
    case 'tool-result':
      return event.isError
        ? {
            ...state,
            feed: [...state.feed, { id: nextId('t'), kind: 'tool-error', text: event.name }],
          }
        : state;
    case 'done': {
      const feed =
        state.turnText.trim() || !event.reply.trim()
          ? state.feed
          : [...state.feed, { id: nextId('a'), kind: 'assistant' as const, text: event.reply }];
      return {
        ...state,
        feed,
        messages: event.reply.trim()
          ? [...state.messages, { role: 'assistant', content: event.reply }]
          : state.messages,
        running: false,
      };
    }
    case 'error':
      return {
        ...state,
        feed: [...state.feed, { id: nextId('e'), kind: 'error', text: event.message }],
        running: false,
      };
    default:
      return state;
  }
}

/** Заметка в ленте: отказ до запуска, остановка, открытая страница, итог карточки. */
export function withNotice(
  state: ConversationState,
  kind: 'notice' | 'error',
  text: string,
): ConversationState {
  return { ...state, feed: [...state.feed, { id: nextId('n'), kind, text }] };
}

/**
 * Ход не дошёл до итога (отказ, обрыв, остановка). Последняя реплика человека
 * остаётся в ленте, но уходит из истории: сервер требует, чтобы история
 * кончалась репликой человека, и повторная отправка иначе несла бы её дважды.
 */
export function withTurnAborted(state: ConversationState): ConversationState {
  const last = state.messages[state.messages.length - 1];
  return {
    ...state,
    running: false,
    messages: last?.role === 'user' ? state.messages.slice(0, -1) : state.messages,
  };
}

/** Разговор из истории: лента из его реплик, продолжение — тем же id. */
export function fromConversation(conversation: PanelAgentConversation): ConversationState {
  return {
    conversationId: conversation.id,
    messages: conversation.messages.map(({ role, content }) => ({ role, content })),
    feed: conversation.messages.map((message) => ({
      id: nextId(message.role === 'user' ? 'u' : 'a'),
      kind: message.role,
      text: message.content,
    })),
    running: false,
    turnText: '',
  };
}

/**
 * Разобрать кусок потока `POST /api/agent/run` на кадры. Возвращает кадры и
 * хвост, который ещё не дописан. Пинг (`: ping`) и битый JSON пропускаются:
 * один неразборный кадр не должен ронять весь ход.
 */
export function splitRunFrames(buffer: string): { events: PanelAgentRunEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: PanelAgentRunEvent[] = [];
  for (const part of parts) {
    const line = part.split('\n').find((piece) => piece.startsWith('data:'));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5)) as PanelAgentRunEvent);
    } catch {
      // неразборный кадр — пропускаем
    }
  }
  return { events, rest };
}
