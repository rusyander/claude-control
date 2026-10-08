import type { Platform, PlatformRulesApplies } from '@agentdeck/contracts';
import { platformRulesApplies } from '@agentdeck/contracts';

/** Выбор этого контура; запись без поля или с мусором — «оба набора». */
export function rulesAppliesOf(platform: Platform): PlatformRulesApplies {
  const value = platform.rules?.applies;
  return platformRulesApplies.find((known) => known === value) ?? 'both';
}
