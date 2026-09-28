/**
 * Лента разговора с агентом панели — одна для окна панели и телефона (А8).
 * Чистые функции без импортов-значений: телефон берёт модуль исходником через
 * Metro (`VALUE_MODULES`); сервер берёт отсюда только `sealFooter`. Второй копии разбора кадров у
 * телефона нет — иначе два экрана одного разговора разошлись бы молча.
 */
import type {
  PanelAgentConversation,
  PanelAgentMessage,
  PanelAgentRunEvent,
  PanelAgentSeal,
  PanelAgentSealReason,
} from './panel-agent';

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
      // Упавший ход — тот же обрыв: иначе просьба уехала бы контекстом в следующий
      // ход, и модель выполнила бы её заново (сессия откат уже не делает — ход стоит).
      return withTurnAborted({
        ...state,
        feed: [...state.feed, { id: nextId('e'), kind: 'error', text: event.message }],
      });
    default:
      return state;
  }
}

/**
 * Событие агента — этого окна? Переход страницы и строка итога карточки
 * принадлежат разговору, который их вызвал: вторая вкладка или телефон с
 * другим разговором не должны уводить экран и писать чужие итоги к себе.
 * Событие без разговора (вызов не из прогона) — общее, как было.
 */
export function isOwnConversationEvent(
  eventConversationId: string | undefined,
  state: Pick<ConversationState, 'conversationId'>,
): boolean {
  return eventConversationId === undefined || eventConversationId === state.conversationId;
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
  return { ...state, running: false, messages: withoutTrailingUser(state.messages) };
}

function withoutTrailingUser<T extends { role: string }>(messages: T[]): T[] {
  return messages[messages.length - 1]?.role === 'user' ? messages.slice(0, -1) : messages;
}

const SEAL_REASON_EN: Record<PanelAgentSealReason, string> = {
  restart: 'the panel restarted mid-turn.',
  stopped: 'the turn was stopped.',
  timeout: 'the agent did not finish the turn within the time limit.',
  failed: 'the turn broke off.',
};

/**
 * Хвост запечатанного ответа — ТО, что прочтёт модель следующим ходом, поэтому
 * по-английски (D-E). Один на сервер (пишет) и окна (узнают и заменяют
 * пометкой на языке человека): разойдись они — окно показало бы английский.
 */
export function sealFooter(seal: PanelAgentSeal): string {
  const reason = seal.detail
    ? `${SEAL_REASON_EN[seal.reason]} ${seal.detail}`
    : SEAL_REASON_EN[seal.reason];
  return [
    ...(seal.actions.length ? [`Actions performed: ${seal.actions.join(', ')}.`] : []),
    `The answer was not finished: ${reason}`,
  ].join('\n\n');
}

/** Пометка запечатанного ответа на языке человека — её собирает окно из словаря. */
export type SealNote = (seal: PanelAgentSeal) => string;

/** Слова пометки из словаря окна (панель и телефон): сборка одна на обоих. */
export interface SealNoteWords {
  actions: (list: string) => string;
  /** Пометка неудачного действия вместо английской ` (failed)`. */
  failed: (name: string) => string;
  notFinished: (reason: string) => string;
  reason: Record<PanelAgentSealReason, string>;
}

export function sealNoteFrom(words: SealNoteWords): SealNote {
  return (seal) => {
    const list = seal.actions.map((action) =>
      action.endsWith(' (failed)') ? words.failed(action.slice(0, -' (failed)'.length)) : action,
    );
    const reason = seal.detail
      ? `${words.reason[seal.reason]} ${seal.detail}`
      : words.reason[seal.reason];
    return [
      ...(list.length ? [words.actions(list.join(', '))] : []),
      words.notFinished(reason),
    ].join('\n\n');
  };
}

/** Текст реплики для ленты: у запечатанной английский хвост заменён пометкой окна. */
function feedText(
  message: PanelAgentConversation['messages'][number],
  sealNote: SealNote | undefined,
): string {
  if (!message.seal || !sealNote) return message.content;
  const footer = sealFooter(message.seal);
  if (!message.content.endsWith(footer)) return message.content;
  const said = message.content.slice(0, -footer.length).trimEnd();
  return [said, sealNote(message.seal)].filter(Boolean).join('\n\n');
}

/**
 * Разговор из истории: лента из его реплик, продолжение — тем же id. История
 * несёт текст файла как есть (его видит модель); лента — с пометкой окна.
 */
export function fromConversation(
  conversation: PanelAgentConversation,
  sealNote?: SealNote,
): ConversationState {
  return {
    conversationId: conversation.id,
    // Файл пишется ДО хода: упавший ход оставил в конце реплику человека без
    // ответа. В ленте она видна, в историю продолжения не идёт.
    messages: withoutTrailingUser(
      conversation.messages.map(({ role, content }) => ({ role, content })),
    ),
    feed: conversation.messages.map((message) => ({
      id: nextId(message.role === 'user' ? 'u' : 'a'),
      kind: message.role,
      text: feedText(message, sealNote),
    })),
    running: false,
    turnText: '',
  };
}

/**
 * Остановленный или упавший ход, в котором агент уже что-то сказал или сделал,
 * сервер запечатывает в файле разговора («Ответ не дописан…»). Окно же сбрасывает
 * пару (`withTurnAborted`) и без перечитки держало свою, более короткую историю
 * до конца сессии: запечатанный ответ видела модель, а человек — только после
 * повторного открытия (ревью Z5-2). Файл длиннее ленты — берём файл и ту же
 * строку об итоге; окно уже ушло дальше (новый ход, другой разговор) или файл не
 * длиннее — `undefined`, ленту не трогаем.
 */
export function withSealedTurnCaughtUp(
  local: ConversationState,
  server: PanelAgentConversation,
  kind: 'notice' | 'error',
  text: string,
  sealNote?: SealNote,
): ConversationState | undefined {
  if (local.running || local.conversationId !== server.id) return undefined;
  const sealed = fromConversation(server, sealNote);
  if (sealed.messages.length <= local.messages.length) return undefined;
  return withNotice(sealed, kind, text);
}

/**
 * Перечитанный после обрыва разговор — в ленту, только если экран всё ещё на
 * нём. Перечитка ждёт до ~10 с, а «Новый разговор» доступен и во время хода:
 * без сверки старый разговор ложился под события нового хода (ревью F-66).
 * Экран ушёл (новый разговор, другой из истории) — `undefined`, ленту не трогаем.
 */
export function withReloadedConversation(
  local: Pick<ConversationState, 'conversationId'>,
  server: PanelAgentConversation,
  kind: 'notice' | 'error',
  text: string,
  sealNote?: SealNote,
): ConversationState | undefined {
  if (local.conversationId !== server.id) return undefined;
  return withNotice(fromConversation(server, sealNote), kind, text);
}

export interface SettledReloadOptions {
  /** Сколько раз спросить сервер, прежде чем сдаться. */
  attempts?: number;
  /** Сколько раз ещё подождать, если ход в файле не запечатан. */
  unsealedWaits?: number;
  /** Пауза между попытками; таймеров у контрактов нет — её даёт клиент. */
  wait: () => Promise<void>;
}

/**
 * Перечитать разговор после обрыва потока. Две гонки, на которых одна попытка
 * показывала голую просьбу или общую ошибку (ревью Z5-3/Z5-4): сервер умер без
 * висящего прокси — поток рвётся сразу, а панель ещё поднимается; и сервер запечатывает
 * ход только после выхода CLI — чтение сразу после обрыва застаёт в конце файла
 * просьбу без ответа. Ход без сказанного и сделанного так и остаётся без ответа —
 * поэтому ждём ограниченно, а потом показываем то, что есть.
 */
export async function reloadSettledConversation(
  fetchConversation: () => Promise<PanelAgentConversation>,
  { attempts = 5, unsealedWaits = 1, wait }: SettledReloadOptions,
): Promise<PanelAgentConversation | undefined> {
  let waitsLeft = unsealedWaits;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let conversation: PanelAgentConversation | undefined;
    try {
      conversation = await fetchConversation();
    } catch {
      if (attempt < attempts) await wait();
      continue;
    }
    const last = conversation.messages[conversation.messages.length - 1];
    if (last?.role !== 'user' || waitsLeft <= 0 || attempt === attempts) return conversation;
    waitsLeft -= 1;
    await wait();
  }
  return undefined;
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
