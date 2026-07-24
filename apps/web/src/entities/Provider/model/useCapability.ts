import type { Capability } from '@claude-control/contracts';
import { useSettings } from '@entities/AppConfig';
import { useProviders } from '../api/ProviderApi';
import { isCapabilityReady } from './gating';

/**
 * Готова ли возможность у активного провайдера — точечный гейт ВНУТРИ страницы.
 *
 * Нужен там, где раздел общий для всех провайдеров, а отдельный элемент на нём —
 * нет: например скрипты работают у любого CLI, но песочница и отметка
 * «вызывается хуком» имеют смысл только у Claude. Правила решения — в
 * `isCapabilityReady` (там же они и проверяются тестами).
 */
export function useIsCapabilityReady(capability: Capability): boolean {
  const { data: settings } = useSettings();
  const { data: providers } = useProviders();

  return isCapabilityReady(settings?.provider, providers, capability);
}
