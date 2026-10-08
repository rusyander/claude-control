import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';

/**
 * Список ждущих карточек после кадра. Новая карточка встаёт в конец (порядок
 * вопросов агента), повтор того же id заменяет старую — кадр может прийти и
 * после того, как список уже перечитан с сервера. Решённая карточка уходит:
 * итог приходит только кадром `agent-decided`, ответ на клик его не несёт.
 */
export function withPending(
  list: PanelPendingAction[] | undefined,
  pending: PanelPendingAction,
): PanelPendingAction[] {
  const current = list ?? [];
  if (current.some((item) => item.id === pending.id)) {
    return current.map((item) => (item.id === pending.id ? pending : item));
  }
  return [...current, pending];
}
