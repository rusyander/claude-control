import type { Platform, OurRules } from '@agentdeck/contracts';
import { ourRules } from './ourRules';

/** Настройка контура с изменённым нашим слоем. */
export function withOurRule(platform: Platform, field: keyof OurRules, value: boolean): Platform {
  return {
    ...platform,
    rules: { ...platform.rules, ours: { ...ourRules(platform), [field]: value } },
  };
}
