import type { HopRequestRules, HopRuleValue } from '@agentdeck/contracts/core/hops';
import { defaultPlatformRules, platformRulesApplies } from '@agentdeck/contracts/platform';
import { platformManifestDeclared, platformPreset } from '@agentdeck/contracts/platform-presets';
import type { GatewayProfile } from './gateway.types.ts';

/**
 * Управляемые правила контура (Т7, решение Р5) — в поля провода для звена (`requestRules`).
 *
 * Перенос `applyManagedRules` + `refusesStream` шлюза панели: список правил — из манифеста базы
 * (платформа компании объявляет инструменты, режим цикла, пресет; любая база — поле размышлений,
 * если оно объявлено), значения — из выбора человека. Звено кладёт поля, не зная, что они значат,
 * поэтому решение «что уходит» принимается ЗДЕСЬ, одним кодом для шлюза человека и метки сеанса.
 *
 * Правило без объявления не отправляется: настройка живёт на контуре и переживает смену драйвера,
 * а поле там, где о нём не объявлено, — 400 у одних и молча выброшенное у других.
 */

type Profile = Pick<GatewayProfile, 'driver' | 'manifest' | 'rules'>;

/** Чьи правила действуют (баг 11б): «только наши» — правила контура по умолчанию. */
function effectiveRules(profile: Profile) {
  const applies = platformRulesApplies.find((known) => known === profile.rules?.applies) ?? 'both';
  return applies !== 'ours' && profile.rules ? profile.rules.platform : defaultPlatformRules();
}

export function contourRequestRules(profile: Profile, forceStream: boolean): HopRequestRules {
  const declared = platformManifestDeclared(profile.driver, profile.manifest);
  const rules = effectiveRules(profile);
  const set: { path: string; value: HopRuleValue }[] = [];
  const streamless: { path: string; values: string[] }[] = [];
  if (platformPreset(profile.driver).base === 'enterprise-platform') {
    const prefix = declared.vendorPrefix;
    // Пустой список инструментов — ВЫКЛЮЧЕНО, а не «панель промолчала»: контур, ничего не
    // получивший, берёт свои по умолчанию; «не надо» на проводе — `tool_choice: "none"`.
    if (rules.platformTools.length > 0)
      set.push({ path: `${prefix}_tools`, value: [...rules.platformTools] });
    else set.push({ path: 'tool_choice', value: 'none' });
    // Режим цикла без инструментов контура не значит ничего.
    if (rules.platformTools.length > 0)
      set.push({ path: `${prefix}_tool_mode`, value: rules.toolMode });
    // Маршрут чата контура с `single_turn` и потоком — 400.
    streamless.push({ path: `${prefix}_tool_mode`, values: ['single_turn'] });
    if (rules.generationPreset.trim())
      set.push({ path: 'generation_preset', value: rules.generationPreset.trim() });
  }
  // «По умолчанию» — отсутствие поля, «выключено» — `false`: у контуров это различается.
  if (declared.thinkingField && rules.enableThinking !== 'default')
    set.push({ path: declared.thinkingField, value: rules.enableThinking === 'on' });
  return { set, streamless, forceStream };
}
