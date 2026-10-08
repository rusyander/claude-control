import type { PlatformRules, Platform } from '@agentdeck/contracts';
import { platformRules } from './rulesView';

/** Настройка контура с изменённым правилом. */
export function withRule<K extends keyof PlatformRules>(
  platform: Platform,
  field: K,
  value: PlatformRules[K],
): Platform {
  return {
    ...platform,
    rules: { ...platform.rules, platform: { ...platformRules(platform), [field]: value } },
  };
}
