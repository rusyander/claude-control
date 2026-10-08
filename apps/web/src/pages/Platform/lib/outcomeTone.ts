import type { PlatformAgentOutcome } from '@agentdeck/contracts';

/**
 * Тон исхода. «Недоступно» — НЕ ошибка: агентов может не быть в лицензии
 * компании, и красный цвет послал бы человека чинить то, что не ломалось.
 * Объявленное автором завершение агента — тоже не поломка панели.
 */
export function outcomeTone(
  outcome: PlatformAgentOutcome,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (outcome === 'ok') return 'success';
  if (outcome === 'unavailable' || outcome === 'agent-error' || outcome === 'not-ready') {
    return 'warning';
  }
  return 'danger';
}
