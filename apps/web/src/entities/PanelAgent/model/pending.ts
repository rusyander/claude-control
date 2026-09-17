import type { PanelActionRisk, PanelPendingAction } from '@agentdeck/contracts/panel-agent';

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

export function withoutPending(
  list: PanelPendingAction[] | undefined,
  id: string,
): PanelPendingAction[] {
  return (list ?? []).filter((item) => item.id !== id);
}

/**
 * Какая кнопка карточки получает фокус первой. Опасное действие — «Отклонить»:
 * Enter по привычке не должен включать контур или запускать агента.
 */
export function initialDecision(risk: Exclude<PanelActionRisk, 'read'>): 'approve' | 'reject' {
  return risk === 'danger' ? 'reject' : 'approve';
}
