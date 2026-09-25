import type { AppState, ChatLink } from './app-store.types.ts';

/**
 * Откуда взялся чат: связь «родитель → потомок» для чатов, заведённых
 * разделением задач.
 *
 * Хранится у панели, а не выводится из транскриптов, потому что вывести её
 * оттуда нельзя: у Claude Code нет понятия «этот разговор порождён тем». Для
 * человека же это главное, что о таком чате нужно знать, — он видит в списке
 * дерево и понимает, какие пять чатов приехали из одной просьбы.
 *
 * Ключ двойной по необходимости. Разделение заводит чат под временным
 * `new-<ts>-<n>`, а настоящий `sessionId` Claude Code выдаёт позже, уже в
 * прогоне. Пока его нет, дерево должно работать (иначе первые полминуты чаты
 * висят без родителя); когда он появляется — связь переносится на него, потому
 * что в списке чат живёт уже под ним. Обе записи оставляем: временный ключ
 * встречается в памяти вкладок, и терять его нельзя.
 */

/** Сколько связей помним. Пять чатов на разделение — сотня разделений назад. */
const MAX_LINKS = 500;

/**
 * Живые связи. Снятые перезапуском (`retiredAt`) отсюда не выходят: для всех
 * читателей панели — конвейера, пауз, прав, повторов — такое звено всё равно
 * что удалено, и ни один из них не должен принять его за работающую группу.
 */
export function getChatLinks(state: AppState): Record<string, ChatLink> {
  const all = state.chatLinks ?? {};
  if (!Object.values(all).some((link) => link.retiredAt)) return all;
  return Object.fromEntries(Object.entries(all).filter(([, link]) => !link.retiredAt));
}

/** Родитель этого чата, если он порождён разделением и звено не снято. */
export function getChatLink(state: AppState, chatId: string): ChatLink | undefined {
  const link = state.chatLinks?.[chatId];
  return link && !link.retiredAt ? link : undefined;
}

/** Снятые звенья — только списку чатов: чтобы старый разговор остался под родителем. */
export function getRetiredChatLinks(state: AppState): Record<string, ChatLink> {
  return Object.fromEntries(
    Object.entries(state.chatLinks ?? {}).filter(([, link]) => link.retiredAt),
  );
}

/**
 * Снять звено, не стирая связь (перезапуск групп разделения). Раньше связь
 * удалялась, и старые чаты групп всплывали в списке корнями — восемь разом
 * (журнал живого прогона, находка 20). Молчит, когда связи нет или она уже снята.
 */
export function retireChatLink(state: AppState, chatId: string, at: string): boolean {
  const link = state.chatLinks?.[chatId];
  if (!link || link.retiredAt) return false;
  link.retiredAt = at;
  return true;
}

export function setChatLink(state: AppState, chatId: string, link: ChatLink): void {
  if (!state.chatLinks) state.chatLinks = {};
  state.chatLinks[chatId] = link;
  prune(state);
}

/**
 * Убрать связь под ключом, которого не будет.
 *
 * Повод ровно один, и он же единственный законный: звено заведено под временным
 * ключом, а настоящий выдало хранилище чужого провайдера (`codex:c1a2…`).
 * Дерево строится по КЛЮЧАМ связей, и оставленный временный висел бы в хабе
 * строкой, за которой нет разговора.
 */
export function clearChatLink(state: AppState, chatId: string): boolean {
  if (!state.chatLinks?.[chatId]) return false;
  delete state.chatLinks[chatId];
  return true;
}

/**
 * Прогон назвал свой настоящий `sessionId` — переносим связь на него.
 *
 * Ничего не делаем, когда связи нет: под этот путь попадает КАЖДЫЙ прогон
 * панели, а не только порождённый разделением.
 */
export function linkChatSession(state: AppState, chatId: string, sessionId: string): boolean {
  const link = state.chatLinks?.[chatId];
  if (!link || chatId === sessionId) return false;
  if (state.chatLinks?.[sessionId]) return false;
  // Канонический ключ разговора (Д11) — первый, под которым связь записана.
  // Одинаковое содержимое двух ключей держится лишь до первой записи поля под
  // одним из них (`saveLink`, `markReviewed`), а после перезапуска это и вовсе
  // два разных объекта.
  link.conversation ??= chatId;
  setChatLink(state, sessionId, link);
  return true;
}

/**
 * Связь, скопированная на ДРУГОЙ разговор — продолжение («перейти в чистый
 * чат»), звено каскада, чат правок по ревью: родитель и назначение переезжают,
 * а канонический ключ — нет. С чужим ключом дерево склеило бы новый разговор со
 * старым в один узел (Д11).
 */
export function carriedLink(link: ChatLink): ChatLink {
  const { conversation: _closed, ...rest } = link;
  return { ...rest, createdAt: new Date().toISOString() };
}

/**
 * Признак одного разговора. Связи старше канонического ключа узнаются по
 * содержимому — как узнавались до него.
 */
export function linkIdentity(link: ChatLink): string {
  return link.conversation ? `c:${link.conversation}` : `j:${JSON.stringify(link)}`;
}

/** Связь под ключом `chatId` и все ключи того же разговора. */
export function conversationKeys(links: Record<string, ChatLink>, chatId: string): string[] {
  const link = links[chatId];
  if (!link) return [];
  // Канонический ключ разговора (Д11): одинаковое содержимое связи переставало
  // быть признаком одного разговора, как только одно поле писалось по одному
  // ключу, — и дерево раздваивалось. Старые связи без него — по содержимому.
  if (link.conversation) {
    const keys = Object.keys(links).filter((key) => links[key]?.conversation === link.conversation);
    return keys.includes(chatId) ? keys : [chatId, ...keys];
  }
  const identity = JSON.stringify(link);
  return Object.keys(links).filter((key) => JSON.stringify(links[key]) === identity);
}

/** Самые старые связи вытесняются: файл состояния не должен расти без края. */
function prune(state: AppState): void {
  const links = state.chatLinks ?? {};
  const keys = Object.keys(links);
  if (keys.length <= MAX_LINKS) return;

  const ordered = keys.sort((a, b) =>
    (links[a]?.createdAt ?? '').localeCompare(links[b]?.createdAt ?? ''),
  );
  for (const key of ordered.slice(0, keys.length - MAX_LINKS)) delete links[key];
}

/**
 * Агент впервые правил код: момент — в связь, один раз. Связь может лежать под
 * временным ключом, под настоящим или под обоими — пишем во все, что есть, и
 * только если момента ещё нет. Без связи молчим: это каждый прогон панели.
 */
export function markChatFirstEdit(state: AppState, keys: readonly string[], at: string): boolean {
  let changed = false;
  for (const key of keys) {
    const link = state.chatLinks?.[key];
    if (!link || link.firstEditAt) continue;
    link.firstEditAt = at;
    changed = true;
  }
  return changed;
}
