import type { ChatSummary } from '@agentdeck/contracts';

type Assignment = Pick<ChatSummary, 'assignedModel' | 'effort'>;

/**
 * Модель и глубина, которые шапка чата считает назначенными разговору.
 *
 * Разговор из списка несёт их сам. Прогон, которого в списке ещё нет, — тоже
 * назначенный: чат вопроса о ходе групп (5.1) заводит сервер на младшей
 * модели, и до конца первого хода вид показывает его как черновик. Без этого
 * шапка и подпись «… думает над ответом» называли модель из настроек, хотя
 * отвечала другая. Свой выбор человека (`chat-model:`) по-прежнему главнее.
 */
export function runAssignment(
  chat: Assignment | undefined,
  run: { model?: string; effort?: string },
): Assignment | undefined {
  if (chat) return chat;
  if (!run.model) return undefined;
  return { assignedModel: run.model, ...(run.effort ? { effort: run.effort } : {}) };
}
