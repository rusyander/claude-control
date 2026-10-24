import type { ChildQuestion } from '../ui/ChildQuestion.types';
import type { ChildPermission } from '../ui/ChildPermission.types';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { parseQuestions } from './parseQuestions';

/**
 * Карточка группы по ЛЮБОМУ ключу её звеньев: ключ чата карточки (последнее
 * звено), ключи остальных звеньев в списке (`chatIds`). Отброшенная перезапуском
 * группа (L20) карточки для запросов не даёт — она не продолжается.
 */
function cardResolver(groups: readonly ChildStageGroup[]): (keys: string[]) => string | undefined {
  const byKey = new Map<string, string>();
  for (const group of groups) {
    if (group.retired || !group.chatId) continue;
    for (const key of [group.chatId, ...(group.chatIds ?? [])]) {
      if (!byKey.has(key)) byKey.set(key, group.chatId);
    }
  }
  return (keys) => keys.map((key) => byKey.get(key)).find(Boolean);
}

/** Все ключи, под которыми разговор запроса известен; первым — ключ прогона. */
const keysOf = (ask: { chatId: string; chatKeys?: string[] }): string[] => [
  ask.chatId,
  ...(ask.chatKeys ?? []),
];

/**
 * Разложить запросы по карточкам групп: что нашло карточку — в `inCards` под её
 * ключом, остальное — в полосу над хабом (`strip`).
 */
function splitByCard<T extends { chatId: string; chatKeys?: string[] }>(
  groups: readonly ChildStageGroup[],
  asks: readonly T[],
): { inCards: Map<string, T[]>; strip: T[] } {
  const cardOf = cardResolver(groups);
  const inCards = new Map<string, T[]>();
  const strip: T[] = [];
  for (const ask of asks) {
    const card = cardOf(keysOf(ask));
    if (!card) {
      strip.push(ask);
      continue;
    }
    inCards.set(card, [...(inCards.get(card) ?? []), ask]);
  }
  return { inCards, strip };
}

/**
 * Чей вопрос — в карточку группы, а чей — в полосу над хабом.
 *
 * Владелец 20.10 (карточка 27): вопрос агента группы искали в её карточке и не
 * находили — он стоял полосой над всем хабом, без стадии и без чата. Теперь
 * вопрос разговора, у которого в хабе есть своя карточка, живёт в ней.
 *
 * Карточка ищется по ВСЕМ ключам разговора (владелец 23.10): живой вопрос
 * приходит под ключом прогона, а разговор, заведённый панелью, живёт под
 * временным `new-…`, пока CLI не назовёт сессию, — и по одному `chatId` вопрос
 * группы уходил в полосу над хабом. Вопрос любого другого ребёнка (вложенный
 * чат группы, у которого карточки в этом хабе нет) остаётся в полосе — иначе
 * он пропал бы совсем.
 */
export function cardQuestions(
  groups: readonly ChildStageGroup[],
  questions: readonly ChildQuestion[],
): { inCards: Map<string, ChildQuestion[]>; strip: ChildQuestion[] } {
  // Тело, которое не разобрать, показывать нечем: без него осталась бы одна
  // подпись «спрашивает» над пустым местом.
  const shown = questions.filter((question) => question.text || parseQuestions(question.input));
  return splitByCard(groups, shown);
}

/**
 * Чей запрос прав — в карточку группы, а чей — в полосу над хабом (владелец
 * 23.10): «Агент просит разрешение» висел плашкой над хабом с подписью
 * «Просит «<группа>»», а искали его в карточке той группы, что стоит. Правило
 * то же, что у вопросов: есть своя карточка — в ней, нет — в полосе.
 */
export function cardPermissions(
  groups: readonly ChildStageGroup[],
  permissions: readonly ChildPermission[],
): { inCards: Map<string, ChildPermission[]>; strip: ChildPermission[] } {
  return splitByCard(
    groups,
    permissions.filter((child) => child.permissions.length > 0),
  );
}
