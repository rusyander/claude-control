import type { PanelAgentConversation } from '@agentdeck/contracts/panel-agent';
import {
  fromConversation,
  withNotice,
  type ConversationState,
  type SealNote,
} from './conversation';

/**
 * Что окно агента помнит о себе через F5 — в sessionStorage вкладки: другая
 * вкладка ведёт свой разговор, и общая память переключила бы её на чужой.
 * Исключение — «Дублировать вкладку»: браузер копирует sessionStorage, и обе
 * вкладки восстанавливают и продолжают один разговор. Это ловит сервер: ход
 * отставшей вкладки получает `conversation_stale`, и она перечитывает разговор.
 *
 * Разговор живёт в памяти страницы, и перезагрузка (F5, горячая перезагрузка
 * дев-сервера) выбрасывала его: окно открывалось пустым, а ход, оборванный
 * перезагрузкой, и снятая карточка исчезали без слова. Запрос хода обрывается
 * вместе со страницей, сервер останавливает агента и снимает его карточки —
 * вернуть ход нельзя, но вернуть разговор и сказать, что случилось, можно.
 */
export const WINDOW_MEMORY_KEY = 'agentdeck:panel-agent-window';

export interface WindowMemory {
  conversationId: string;
  /** Ход шёл, когда вкладку оставили: перезагрузка его оборвала. */
  turnOpen: boolean;
}

type ReadableStorage = Pick<Storage, 'getItem'>;

/** Хранилище вкладки; сам доступ к нему бросает при запрете данных сайта. */
export function sessionStore(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;

export function readWindowMemory(storage: ReadableStorage | undefined): WindowMemory | undefined {
  try {
    const raw = storage?.getItem(WINDOW_MEMORY_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<WindowMemory>;
    if (typeof value.conversationId !== 'string' || !value.conversationId) return undefined;
    return { conversationId: value.conversationId, turnOpen: value.turnOpen === true };
  } catch {
    // Битая запись или хранилище недоступно — окно начинает с чистого листа.
    return undefined;
  }
}

export function writeWindowMemory(
  storage: WritableStorage | undefined,
  memory: WindowMemory | undefined,
): void {
  try {
    if (memory) storage?.setItem(WINDOW_MEMORY_KEY, JSON.stringify(memory));
    else storage?.removeItem(WINDOW_MEMORY_KEY);
  } catch {
    // Приватный режим или запрет данных сайта: окно работает без памяти через F5.
  }
}

/**
 * Восстановление пропущено: в ленту до ответа сервера уже легла заметка. Сам
 * разговор не подменяем, но «ход открыт» из памяти снимаем — иначе следующий F5
 * снова сказал бы «ход оборван перезагрузкой» о ходе, которого давно нет
 * (F-288). Пишем, только если память всё та же: успевший начаться новый ход
 * записал свою, и её не трогаем.
 */
export function closeSkippedTurn(
  storage: (ReadableStorage & WritableStorage) | undefined,
  read: WindowMemory,
): void {
  if (!read.turnOpen) return;
  const now = readWindowMemory(storage);
  if (now?.conversationId !== read.conversationId || !now.turnOpen) return;
  writeWindowMemory(storage, { conversationId: read.conversationId, turnOpen: false });
}

/**
 * Разговор после перезагрузки. Ход, который шёл в момент перезагрузки, уже
 * остановлен сервером, и последняя реплика человека осталась без ответа —
 * `fromConversation` не отправит её повторно; заметка объясняет почему.
 */
export function restoredConversation(
  conversation: PanelAgentConversation,
  turnOpen: boolean,
  interruptedNote: string,
  sealNote?: SealNote,
): ConversationState {
  const state = fromConversation(conversation, sealNote);
  return turnOpen ? withNotice(state, 'error', interruptedNote) : state;
}
