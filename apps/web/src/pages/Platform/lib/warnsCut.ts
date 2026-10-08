import type { PlatformAgentAnswer } from '@agentdeck/contracts';

/**
 * Предупреждать ли, что ответ оборван.
 *
 * Контур называет причину завершения только когда она есть, и всё, кроме
 * `stop`, означает, что агент не договорил: упёрся в предел вывода, был
 * остановлен фильтром, оборван по времени. Без этой строки на экране — обычный
 * зелёный «Ответил» и текст, обрывающийся на полуслове, а через переходник
 * такой обрывок уходит локальной модели как законченный ответ, и она на нём
 * действует.
 */
export function warnsCut(answer: PlatformAgentAnswer | undefined): boolean {
  if (answer?.outcome !== 'ok') return false;
  return answer.finishReason !== undefined && answer.finishReason !== 'stop';
}
