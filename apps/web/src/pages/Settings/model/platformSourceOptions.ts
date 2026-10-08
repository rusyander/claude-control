import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Контуры, которые ГОДЯТСЯ в источники каталога.
 *
 * Годится не всякий: у выключенного и у бесключевого панель ничего не спросит,
 * и предлагать их в выпадающем списке значит предлагать выбрать поломку. Уже
 * ВЫБРАННЫЙ контур остаётся в списке даже негодным — иначе он молча пропадает
 * из поля, и человек не понимает, что вообще выбрано.
 */
export function platformSourceOptions(
  platforms: PlatformStatus[] | undefined,
  selectedId: string,
): PlatformStatus[] {
  return (platforms ?? []).filter(
    (status) => (status.platform.enabled && status.hasToken) || status.platform.id === selectedId,
  );
}
