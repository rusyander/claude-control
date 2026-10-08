import type { Platform } from '@agentdeck/contracts';

/**
 * Решения карточки «Агенты контура» — здесь, а не в разметке: прогон фронта
 * идёт в node и компонентов не рендерит, а решений тут ровно те, в которых
 * можно соврать человеку.
 */

/**
 * Почему спросить нельзя — либо пусто, если можно.
 *
 * Причины разные и чинятся в разных местах: контур выключен (тумблер в
 * карточке), ключа нет (мастер), агент не выбран (список тут же), вопрос пуст
 * (поле ввода). Одна серая кнопка без объяснения оставляет человека гадать,
 * какое из четырёх.
 */
export type AskBlocker = 'disabled' | 'no-token' | 'no-agent' | 'no-question' | '';

export function askBlocker(
  platform: Platform,
  hasToken: boolean,
  agentId: string,
  question: string,
): AskBlocker {
  if (!platform.enabled) return 'disabled';
  if (!hasToken) return 'no-token';
  if (!agentId) return 'no-agent';
  if (!question.trim()) return 'no-question';
  return '';
}
