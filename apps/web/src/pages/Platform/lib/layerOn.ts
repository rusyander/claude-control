import type { OurRules, OurLayerId } from '@agentdeck/contracts';

/**
 * Действует ли слой НА ЭКРАНЕ. Та же мысль, что в `domains/platform/layers/layers.ts`:
 * общий выключатель сильнее частных галочек. Считать здесь нечего — это одно
 * «и», и держать ради него сетевой ответ было бы дороже, чем повторить; всё, что
 * СЛОЖНЕЕ этого (флаги запуска), карточка берёт готовым с сервера.
 */
export function layerOn(rules: OurRules, layer: OurLayerId): boolean {
  // `tools` не из `~/.claude`: общий выключатель его не трогает (см. контракт).
  if (layer === 'tools') return rules.tools !== false;
  return rules.enabled && rules[layer];
}
