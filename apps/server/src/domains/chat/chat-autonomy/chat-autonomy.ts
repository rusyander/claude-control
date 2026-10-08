import {
  AUTONOMOUS_ENV,
  resolveChatGroupSettings,
  type ChatGroupChoice,
  type ChatGroupSettingsView,
  type StoredChatGroupSettings,
} from '@agentdeck/contracts/chat-group-settings';
import { groupKeyOf, parseGroupKey } from '@agentdeck/contracts/group-sources';
import type { AppStore } from '../../../lib/app-store/store.ts';
import type { EntityToggleDeps } from '../../entity-toggle.ts';
import { setGroupEnabled } from '../../group-toggle.ts';

/**
 * Группа и автономность разговора — действующие значения по дереву разделения.
 *
 * Своё у чата сильнее родительского; своего нет — значение родителя, у того —
 * его родителя, и так до корня; у корня без своего — умолчания контракта
 * (`auto`, автономия включена). Ребёнку разделения, которого человек не трогал,
 * так достаётся выбор главного чата, а ручная правка у ребёнка меняет только его.
 *
 * Хранилище сюда не приходит: домен берёт два вопроса-функции, и тест собирает
 * дерево из обычных объектов.
 */
export interface ChatTreeReader {
  /** Своё у разговора под этим ключом (любым его написанием). */
  own: (key: string) => StoredChatGroupSettings | undefined;
  /** Родитель разговора по связи разделения; нет — корень. */
  parentOf: (key: string) => string | undefined;
}

/**
 * Дерево по хранилищу панели. Связь разделения лежит под ключом, которым её
 * записали (часто временным `new-…`), и копией под `sessionId` — поэтому
 * спрашиваем оба написания.
 */
export function storeTreeReader(
  store: Pick<AppStore, 'getChatGroupSettings' | 'getChatLink' | 'canonicalChatKey'>,
): ChatTreeReader {
  return {
    own: (key) => store.getChatGroupSettings(key),
    parentOf: (key) =>
      (store.getChatLink(key) ?? store.getChatLink(store.canonicalChatKey(key)))?.parentChatId,
  };
}

/** Потолок глубины: дерево разделения мельче, а петля в связях не должна вешать сервер. */
const MAX_DEPTH = 16;

export function chatGroupSettingsView(
  reader: ChatTreeReader,
  keys: readonly string[],
): ChatGroupSettingsView {
  return viewOf(reader, keys, new Set());
}

function viewOf(
  reader: ChatTreeReader,
  keys: readonly string[],
  seen: Set<string>,
): ChatGroupSettingsView {
  const present = keys.filter(Boolean);
  for (const key of present) seen.add(key);
  // Ключи идут `[написание, sessionId]`, и своё ищется с КОНЦА: сессия — тот
  // разговор, который CLI продолжает на самом деле. Обычно оба написания сводятся
  // к одной записи, а у ветки правки прогон ещё держит ключ исходного разговора,
  // и у ветки уже своя запись (F-111). Запись маршрут делает туда же (`keys.at(-1)`).
  const own = firstOf([...present].reverse(), reader.own);
  const parentId = firstOf(present, reader.parentOf);
  if (!parentId || seen.has(parentId) || seen.size > MAX_DEPTH) {
    return resolveChatGroupSettings(own, undefined);
  }
  return resolveChatGroupSettings(own, viewOf(reader, [parentId], seen), parentId);
}

/** Главный чат дерева: вверх по связям до разговора без родителя. */
export function rootChatOf(
  reader: Pick<ChatTreeReader, 'parentOf'>,
  keys: readonly string[],
): string {
  const present = keys.filter(Boolean);
  const seen = new Set(present);
  let current = present.at(-1) ?? '';
  let parent = firstOf(present, reader.parentOf);
  while (parent && !seen.has(parent) && seen.size <= MAX_DEPTH) {
    seen.add(parent);
    current = parent;
    parent = reader.parentOf(parent);
  }
  return current;
}

/**
 * Окружение прогона с меткой автономии или без неё. Снимается безусловно:
 * параметры продолжения приходят из прошлой жизни прогона, и метка оттуда не
 * должна пережить выключенную галочку.
 */
export function withAutonomy(
  env: Record<string, string> | undefined,
  autonomous: boolean,
): Record<string, string> {
  const { [AUTONOMOUS_ENV]: _previous, ...rest } = env ?? {};
  return autonomous ? { ...rest, [AUTONOMOUS_ENV]: '1' } : rest;
}

/**
 * Явно выбранная группа — включить к началу прогона, как включается группа,
 * привязанная к проекту (`group-activation.ts`): только включаем, никогда не
 * гасим — группа правит общие файлы, а прогонов идёт несколько.
 *
 * Только глобальная: проектная группа — это файлы самого проекта, они и так
 * действуют в нём, и включать там нечего. `auto` — дело разбора, не старта.
 * Возвращает имя включённой группы; ничего не включено — `undefined`.
 */
export function activateChosenGroup(
  deps: EntityToggleDeps,
  choice: ChatGroupChoice,
): string | undefined {
  if (choice === 'auto') return undefined;
  const parsed = parseGroupKey(choice);
  if (parsed?.kind !== 'global') return undefined;
  const group = deps.store
    .getGroups()
    .find((candidate) => candidate.id === parsed.id && groupKeyOf(candidate) === choice);
  if (!group || group.isEnabled) return undefined;
  setGroupEnabled(deps, group, true);
  return group.name;
}

function firstOf<T>(keys: readonly string[], read: (key: string) => T | undefined): T | undefined {
  for (const key of keys) {
    const value = read(key);
    if (value !== undefined) return value;
  }
  return undefined;
}
