import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Контур вкладки: названный в адресе, иначе первый в списке (активный стоит
 * первым). Удалённый или чужой идентификатор в адресе не даёт пустой вкладки.
 */
export function pickContour(
  platforms: readonly PlatformStatus[],
  id: string | undefined,
): PlatformStatus | undefined {
  return platforms.find((status) => status.platform.id === id) ?? platforms[0];
}
