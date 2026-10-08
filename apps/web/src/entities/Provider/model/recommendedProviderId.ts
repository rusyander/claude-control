import type { ProviderDetectResponse } from '@agentdeck/contracts';
import { installedProviders } from './installedProviders';

/** Дефолтный провайдер панели — его рекомендуем, когда он установлен. */
export const DEFAULT_PROVIDER_ID = 'claude';

/**
 * Кого рекомендовать: если установлен `claude` — его (проверенный дефолт),
 * иначе первый установленный из списка. Ничего не установлено → `undefined`
 * (рекомендовать нечего). Автопереключения провайдера НЕТ — только бейдж.
 */
export function recommendedProviderId(
  data: ProviderDetectResponse | undefined,
): string | undefined {
  const installed = installedProviders(data);
  const claude = installed.find((item) => item.id === DEFAULT_PROVIDER_ID);
  return (claude ?? installed[0])?.id;
}
