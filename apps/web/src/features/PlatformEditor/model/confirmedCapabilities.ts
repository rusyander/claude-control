import type { PlatformProbeResult, PlatformCapability } from '@agentdeck/contracts';

/**
 * Что проба подтвердила. «Косвенно» считается подтверждением: возможность есть,
 * просто добирается до неё панель не напрямую. «Не объявлено» и «нет» — нет:
 * записать их в подтверждённые значило бы обещать непроверенное.
 */
export function confirmedCapabilities(result: PlatformProbeResult): PlatformCapability[] {
  if (result.outcome !== 'ok') return [];
  return result.capabilities
    .filter((finding) => finding.state === 'yes' || finding.state === 'indirect')
    .map((finding) => finding.id);
}
