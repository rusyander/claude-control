import { knobStepOf } from '@agentdeck/contracts/skill-steps';
import { stepHeadings } from '../path/path.ts';

/**
 * К какому шагу скилла относится число группы — индекс шага с нуля, как у
 * шага скилла в пути; `undefined` — шаг не определить (число встанет на первый).
 *
 * Сам разбор — общий со страницей (`@agentdeck/contracts/skill-steps`): две
 * копии расходились, и число, у которого сервер нашёл шаг, страница ставила на
 * скилл целиком (ревью 28.09, F-230). Шаги — те же, что у строк пути
 * (`stepHeadings`), чтобы индекс числа был индексом строки. Живая доставка
 * тикета 28.09: текст проектного скилла был только у сервера, страница ставила
 * все три числа на шаг 1, и у ревью и правок «чисел не было».
 */
export function knobStep(text: string, quote: string): number | undefined {
  return knobStepOf(text, quote, stepHeadings(text));
}
