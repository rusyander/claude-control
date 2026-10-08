import type { PanelAgentEvent } from '@agentdeck/contracts/panel-agent';

export const AGENT_EVENT_TYPES = new Set(['agent-open-page', 'agent-pending', 'agent-decided']);

/**
 * Кадр агента ли это. Кадры агента идут по тому же `/api/events`, что и
 * `changed`, и разбирает поток один провайдер; всё, что не кадр агента, сюда
 * не пропускаем — окно не должно гадать над формой чужого кадра.
 */
export function isPanelAgentEvent(payload: unknown): payload is PanelAgentEvent {
  if (!payload || typeof payload !== 'object') return false;
  const type = (payload as { type?: unknown }).type;
  return typeof type === 'string' && AGENT_EVENT_TYPES.has(type);
}
