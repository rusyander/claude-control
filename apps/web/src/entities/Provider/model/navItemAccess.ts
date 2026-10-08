import type { NavItem } from '@shared/config/navigation';
import type { ProviderCapabilities, SectionAccess } from './gating.types';
import type { CapabilityStatus } from '@agentdeck/contracts';

/** Доступ к разделу навигации у активного провайдера. */
export function navItemAccess(item: NavItem, capabilities: ProviderCapabilities): SectionAccess {
  // Панель-level раздел виден всегда, от провайдера не зависит.
  if (!item.capability) return 'ready';
  // Данные ещё не пришли — оптимистично считаем раздел доступным (дефолт Claude).
  if (!capabilities) return 'ready';
  const status: CapabilityStatus = capabilities[item.capability] ?? 'unsupported';
  if (status === 'ready') return 'ready';
  if (status === 'planned') return 'inDevelopment';
  return 'hidden';
}
