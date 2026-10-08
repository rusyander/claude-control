import type { PlatformProblem } from './state.types';

/**
 * Каким цветом сказать вердикт. Три состояния, а не два: «ещё не проверялся» —
 * не беда и не успех, и тревожный цвет прочитался бы как поломка контура,
 * которой никто не видел.
 */
export function platformTone(problem: PlatformProblem): 'ok' | 'bad' | 'quiet' {
  if (problem === 'ok') return 'ok';
  if (problem === 'unchecked') return 'quiet';
  return 'bad';
}
