import type { PlatformStatus } from '@agentdeck/contracts';
import { platformSourceOptions } from './platformSourceOptions';

/** Можно ли вообще выбрать источником контур: хоть один готов или уже выбран. */
export function canUsePlatformSource(
  platforms: PlatformStatus[] | undefined,
  selectedId: string,
): boolean {
  return platformSourceOptions(platforms, selectedId).length > 0;
}
