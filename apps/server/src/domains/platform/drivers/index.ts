import type { PlatformDriverId } from '@agentdeck/contracts';
import type { PlatformDriver } from './driver.ts';
import { enterprise-platformDriver } from './enterprise-platform.ts';
import { openAiCompatDriver } from './openai-compat.ts';

/**
 * Реестр драйверов. Ветвление по платформе кончается здесь: дальше все
 * спрашивают возможности, а не имя контура.
 */
const DRIVERS: Record<PlatformDriverId, PlatformDriver> = {
  enterprise-platform: enterprise-platformDriver,
  'openai-compat': openAiCompatDriver,
};

export function driverFor(id: PlatformDriverId): PlatformDriver {
  return DRIVERS[id];
}

export type { PlatformDriver, DriverReading } from './driver.ts';
