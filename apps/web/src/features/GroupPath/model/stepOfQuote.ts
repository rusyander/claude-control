import type { SkillTextStep } from './skillText.types';
import { knobStepOf } from '@agentdeck/contracts/skill-steps';

/**
 * К какому шагу относится цитата числа — тот же разбор, что у сервера
 * (`knobStep`): раздел, в котором стоит цитата (любое её вхождение, не первое),
 * иначе шаг, названный во вступлении («§3», «step 3», «шаг 3»). Не нашлось —
 * шага нет, число относится к скиллу целиком.
 */
export function stepOfQuote(
  steps: SkillTextStep[],
  text: string,
  quote: string,
): number | undefined {
  return knobStepOf(text, quote, steps);
}
