import type { ProvidersResponse, Capability } from '@agentdeck/contracts';
import { activeProvider } from './gating';

/**
 * Готова ли возможность — для точечного гейта ЭЛЕМЕНТА внутри общей страницы
 * (кнопка песочницы на «Скриптах» и т.п.). Правила совпадают с `RouteGate`:
 * claude (в т.ч. пока настройки не пришли — это дефолт) → `true` без ожидания
 * карты; не-claude без карты → `false` (fail-closed).
 */
export function isCapabilityReady(
  providerId: string | undefined,
  data: ProvidersResponse | undefined,
  capability: Capability,
): boolean {
  if ((providerId ?? 'claude') === 'claude') return true;
  if (!data) return false;
  return activeProvider(data)?.capabilities[capability] === 'ready';
}
