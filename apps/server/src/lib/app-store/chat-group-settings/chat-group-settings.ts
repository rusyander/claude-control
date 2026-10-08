import type {
  ChatEscalationEntry,
  EscalationNotice,
  StoredChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';
import type { AppState, StoredChatEscalation } from '../app-store.types.ts';

/**
 * Группа и автономность ЧАТА, заметки главному чату дерева и память о втором
 * написании ключа разговора.
 *
 * Ключ — как у связей разделения (`chat-links.ts`): чат заводится под временным
 * `new-<ts>`, а настоящий `sessionId` Claude Code выдаёт уже в прогоне. Выбор,
 * сделанный в меню до первого сообщения, обязан пережить эту смену — иначе
 * второй же ход шёл бы на умолчаниях. Поэтому при смене ключа запись переезжает
 * на `sessionId`, а временный ключ запоминается синонимом: вкладка ещё какое-то
 * время знает разговор по нему, и чтение по нему обязано найти ту же запись.
 */

/** Сколько записей держим в каждой карте: сотни чатов назад, а не вся история. */
const MAX_ENTRIES = 500;
/** Заметок у одного главного чата: старые вытесняются новыми. */
const MAX_NOTICES_PER_ROOT = 50;
/** Главных чатов с заметками. */
const MAX_ROOTS = 200;

/**
 * Только собственный ключ карты: id чата `constructor`/`toString` иначе
 * находил член `Object.prototype`, и маршрут падал с 500 (F-200).
 */
function ownOf<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Запись собственным свойством: присваивание `__proto__` сменило бы прототип карты. */
function setOwn<T>(map: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Потолок прыжков по синонимам: цепочка длиннее — порча, петля не должна вешать сервер. */
const MAX_ALIAS_HOPS = 8;

/**
 * Настоящий ключ разговора: `new-…` → его `sessionId`, если он уже известен.
 *
 * По цепочке, а не на один шаг (F-111): прежняя версия ПЕРЕНОСИЛА запись на
 * ветку правки и писала второй синоним `s1 → s2`, не трогая первый `new-1 → s1`.
 * Такие цепочки уже лежат в `state.json`, и чтение по первому написанию обязано
 * найти запись там, где она теперь.
 */
export function canonicalChatKey(state: AppState, key: string): string {
  let current = key;
  const seen = new Set([key]);
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const next = ownOf(state.chatKeyAliases, current);
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

export function getChatGroupSettings(
  state: AppState,
  key: string,
): StoredChatGroupSettings | undefined {
  const stored = ownOf(state.chatGroupSettings, canonicalChatKey(state, key));
  return stored ? { ...stored } : undefined;
}

/**
 * Записать своё у чата. Поле `undefined` — «своего нет, брать от родителя или
 * умолчание»; запись без полей удаляется: хранится только отклонение.
 */
export function setChatGroupSettings(
  state: AppState,
  key: string,
  settings: StoredChatGroupSettings,
): StoredChatGroupSettings {
  const canonical = canonicalChatKey(state, key);
  const next: StoredChatGroupSettings = {
    ...(settings.groupChoice !== undefined ? { groupChoice: settings.groupChoice } : {}),
    ...(settings.autonomous !== undefined ? { autonomous: settings.autonomous } : {}),
  };
  state.chatGroupSettings ??= {};
  delete state.chatGroupSettings[canonical];
  if (Object.keys(next).length > 0) setOwn(state.chatGroupSettings, canonical, next);
  pruneOldest(state.chatGroupSettings, MAX_ENTRIES);
  return { ...next };
}

/**
 * Прогон назвал свой `sessionId`. Зовётся на КАЖДОМ прогоне; `true` — было что
 * записать на диск. `from` — сессия, которую прогон продолжал (её знал реестр
 * до этого события).
 *
 * Два разных события под одной сигнатурой:
 *  - ПЕРВАЯ сессия временного ключа — запись переезжает на `sessionId`, ключ
 *    становится синонимом, и синонимы, смотревшие на него, смотрят дальше
 *    (цепочек не заводим);
 *  - ВЕТВЛЕНИЕ (правка сообщения, `--fork-session`): у разговора уже была
 *    сессия, а CLI назвал новую. Ветка — новый разговор в списке, исходный в
 *    нём остаётся, поэтому запись КОПИРУЕТСЯ, а синонимы не трогаются: `new-…`
 *    остаётся написанием разговора, под которым его завели, — дети разделения
 *    ищут родителя именно по нему. Прогон ветки читает по `[ключ, sessionId]`,
 *    и своё у `sessionId` для него сильнее (`chatGroupSettingsView`).
 */
export function aliasChatSession(
  state: AppState,
  chatId: string,
  sessionId: string,
  from?: string,
): boolean {
  if (!chatId || !sessionId || chatId === sessionId) return false;
  // Ключ, уже ставший синонимом ДРУГОЙ сессии, — то же ветвление, даже если
  // реестр прежнюю сессию не помнит (прогон, подобранный после перезапуска).
  const origin = from ?? ownOf(state.chatKeyAliases, chatId);
  if (origin !== undefined && origin !== sessionId) {
    const source = [canonicalChatKey(state, origin), canonicalChatKey(state, chatId)].find((key) =>
      ownOf(state.chatGroupSettings, key),
    );
    return source !== undefined && copyChatGroupSettings(state, source, sessionId);
  }
  let changed = false;
  const aliases = (state.chatKeyAliases ??= {});
  if (ownOf(aliases, chatId) !== sessionId) {
    setOwn(aliases, chatId, sessionId);
    changed = true;
  }
  for (const [alias, target] of Object.entries(aliases)) {
    if (target !== chatId || alias === sessionId) continue;
    setOwn(aliases, alias, sessionId);
    changed = true;
  }
  pruneOldest(aliases, MAX_ENTRIES);
  const own = ownOf(state.chatGroupSettings, chatId);
  if (own && state.chatGroupSettings) {
    // Запись под настоящим ключом старше временной быть не может: временный
    // ключ живёт до первого хода, а под настоящим пишут уже после него.
    if (!ownOf(state.chatGroupSettings, sessionId)) setOwn(state.chatGroupSettings, sessionId, own);
    delete state.chatGroupSettings[chatId];
    changed = true;
  }
  return changed;
}

/** Ветке — копия записи исходного разговора; своё у ветки не перетираем. */
function copyChatGroupSettings(state: AppState, source: string, target: string): boolean {
  const own = ownOf(state.chatGroupSettings, source);
  if (!own || !state.chatGroupSettings || source === target) return false;
  if (ownOf(state.chatGroupSettings, target)) return false;
  setOwn(state.chatGroupSettings, target, { ...own });
  pruneOldest(state.chatGroupSettings, MAX_ENTRIES);
  return true;
}

/** Ключ заметки: один и тот же блок ребёнка, прочитанный дважды, — одна заметка. */
export function escalationId(notice: Pick<EscalationNotice, 'childChatId' | 'text'>): string {
  let hash = 0;
  const source = `${notice.childChatId}\n${notice.text}`;
  for (let index = 0; index < source.length; index += 1) {
    hash = (Math.imul(hash, 31) + source.charCodeAt(index)) | 0;
  }
  return `${notice.childChatId}:${(hash >>> 0).toString(36)}`;
}

/** Заметка в главный чат дерева. `false` — такая уже есть. */
export function addChatEscalation(
  state: AppState,
  root: string,
  notice: EscalationNotice,
): boolean {
  const key = canonicalChatKey(state, root);
  const id = escalationId(notice);
  state.chatEscalations ??= {};
  const list = ownOf(state.chatEscalations, key) ?? [];
  if (list.some((entry) => entry.id === id)) return false;
  const next: StoredChatEscalation[] = [...list, { ...notice, id }];
  setOwn(state.chatEscalations, key, next.slice(-MAX_NOTICES_PER_ROOT));
  pruneOldest(state.chatEscalations, MAX_ROOTS);
  return true;
}

export function listChatEscalations(state: AppState): Record<string, ChatEscalationEntry[]> {
  const out: Record<string, ChatEscalationEntry[]> = {};
  for (const [root, list] of Object.entries(state.chatEscalations ?? {})) {
    out[root] = list.map(({ readAt, ...notice }) => ({ ...notice, read: Boolean(readAt) }));
  }
  return out;
}

/** Человек открыл главный чат: все его заметки прочитаны. `true` — что-то сменилось. */
export function markChatEscalationsRead(state: AppState, root: string, at: string): boolean {
  const list = ownOf(state.chatEscalations, canonicalChatKey(state, root));
  if (!list) return false;
  let changed = false;
  for (const entry of list) {
    if (entry.readAt) continue;
    entry.readAt = at;
    changed = true;
  }
  return changed;
}

/** Порядок ключей объекта — порядок вставки: самые ранние и вытесняем. */
function pruneOldest(map: Record<string, unknown>, max: number): void {
  const keys = Object.keys(map);
  for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete map[key];
}
