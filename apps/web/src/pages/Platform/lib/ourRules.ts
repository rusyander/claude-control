import type { Platform, OurRules } from '@agentdeck/contracts';
import { defaultOurRules } from '@agentdeck/contracts';

/**
 * Наши слои ЭТОГО контура (Т8), даже если поля в записи нет — по той же причине,
 * что и у правил выше: запись старше панели приезжает разворотом архива и с
 * телефона, и падать на ней карточке нельзя.
 */
export function ourRules(platform: Platform): OurRules {
  return platform.rules?.ours ?? defaultOurRules();
}
