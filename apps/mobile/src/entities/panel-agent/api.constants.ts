/**
 * Маршруты агента панели — те же, что зовёт окно на компьютере. Потока
 * `/api/events` у телефона нет (его рвёт фон и экономия батареи), поэтому
 * карточки опрашиваются: пропущенный кадр ничего не теряет, карточка лежит на
 * сервере до решения или таймаута.
 */

export const PANEL_AGENT_KEYS = {
  pending: ['panel-agent', 'pending'] as const,
  journal: ['panel-agent', 'journal'] as const,
  conversations: ['panel-agent', 'conversations'] as const,
};
