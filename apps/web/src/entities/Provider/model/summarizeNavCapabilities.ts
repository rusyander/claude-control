import type { Capability, CapabilityStatus } from '@agentdeck/contracts';
import { NAV_CAPABILITIES } from '@shared/config/navigation';

/** Сводка по возможностям: сколько разделов готово / в разработке / недоступно. */
export interface CapabilitySummary {
  ready: number;
  planned: number;
  unsupported: number;
}

/**
 * Пересчитать сводку по разделам, у которых есть навигация (`NAV_CAPABILITIES`),
 * — её показывает селектор провайдера как превью «сколько разделов доступно».
 */
export function summarizeNavCapabilities(
  capabilities: Record<Capability, CapabilityStatus>,
): CapabilitySummary {
  const summary: CapabilitySummary = { ready: 0, planned: 0, unsupported: 0 };
  for (const capability of NAV_CAPABILITIES) {
    const status = capabilities[capability] ?? 'unsupported';
    if (status === 'ready') summary.ready += 1;
    else if (status === 'planned') summary.planned += 1;
    else summary.unsupported += 1;
  }
  return summary;
}
