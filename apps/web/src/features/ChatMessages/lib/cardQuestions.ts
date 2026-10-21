import type { ChildQuestion } from '../ui/ChildQuestion.types';
import type { ChildStageGroup } from '../ui/ChildStages.types';
import { parseQuestions } from './parseQuestions';

/**
 * Чей вопрос — в карточку группы, а чей — в полосу над хабом.
 *
 * Владелец 20.10 (карточка 27): вопрос агента группы искали в её карточке и не
 * находили — он стоял полосой над всем хабом, без стадии и без чата. Теперь
 * вопрос разговора, у которого в хабе есть своя карточка, живёт в ней. Ключ
 * карточки — последнее звено группы: спрашивает именно оно. Вопрос любого
 * другого ребёнка (ручной чат из родителя, звено, которое карточкой не
 * названо) остаётся в полосе — иначе он пропал бы совсем.
 */
export function cardQuestions(
  groups: readonly ChildStageGroup[],
  questions: readonly ChildQuestion[],
): { inCards: Map<string, ChildQuestion[]>; strip: ChildQuestion[] } {
  const cards = new Set(
    groups.filter((group) => !group.retired && group.chatId).map((group) => group.chatId),
  );
  const inCards = new Map<string, ChildQuestion[]>();
  const strip: ChildQuestion[] = [];
  for (const question of questions) {
    // Тело, которое не разобрать, показывать нечем: без него осталась бы одна
    // подпись «спрашивает» над пустым местом.
    if (!question.text && !parseQuestions(question.input)) continue;
    if (!cards.has(question.chatId)) {
      strip.push(question);
      continue;
    }
    inCards.set(question.chatId, [...(inCards.get(question.chatId) ?? []), question]);
  }
  return { inCards, strip };
}
