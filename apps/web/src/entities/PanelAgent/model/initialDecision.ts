import type { PanelActionRisk } from '@agentdeck/contracts/panel-agent';

/**
 * Какая кнопка карточки получает фокус первой. Опасное действие — «Отклонить»:
 * Enter по привычке не должен включать контур или запускать агента.
 */
export function initialDecision(risk: Exclude<PanelActionRisk, 'read'>): 'approve' | 'reject' {
  return risk === 'danger' ? 'reject' : 'approve';
}
