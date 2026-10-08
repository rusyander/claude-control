import type { Platform, PlatformRulesApplies } from '@agentdeck/contracts';

/** Настройка контура с другим выбором; значения обеих сторон не трогаются. */
export function withApplies(platform: Platform, applies: PlatformRulesApplies): Platform {
  return { ...platform, rules: { ...platform.rules, applies } };
}
