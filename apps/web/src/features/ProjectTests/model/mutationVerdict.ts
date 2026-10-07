import type { ProjectTestMutationCheck } from '@agentdeck/contracts';

/**
 * Итог проверки поломкой одним словом (Ф10):
 * - `caught` — хоть один кейс покраснел на поломке;
 * - `unprotected` — ни один не покраснел, а хоть один остался зелёным;
 * - `noResult` — отчёт ни про один кейс ничего не сказал. Это не «не защищён»:
 *   кейсы просто не дошли до итога (не тот отчёт, другое имя теста).
 *
 * Считается по кейсам, а не по счётчикам ответа: ответ старой панели счётчика
 * `noResult` не знает.
 */
export type MutationVerdict = 'caught' | 'unprotected' | 'noResult';

export function mutationVerdict(check: Pick<ProjectTestMutationCheck, 'cases'>): MutationVerdict {
  const caught = check.cases.filter(
    (item) => item.status === 'failed' || item.status === 'blocked',
  ).length;
  if (caught > 0) return 'caught';
  return check.cases.some((item) => item.status === 'passed') ? 'unprotected' : 'noResult';
}
