/**
 * Счёт тестов в доказательстве строки сита — «2117 passed», «1 failed», «passed: 40»,
 * «прошло 12, упал 1» — и его сверка с записанным прогоном блока «Тесты».
 *
 * Аудит g0 25.10 (F-12): строка project-checks сказала «tests-cli: … 2117 passed», а
 * прогон за ней напечатал «1 failed, 2117 passed»; другая строка несла «1311 passed» с
 * прошлого круга. Оба текста ушли заметками в описание MR. Судья сверял числа только у
 * живых сит, а счёт словами принимал как есть.
 */

const PASS_WORD = String.raw`passed|прошл\p{L}*|пройден\p{L}*`;
const FAIL_WORD = String.raw`failed|упал\p{L}*|провален\p{L}*`;
/** «N слово» или «слово: N» / «слово=N»; запятая — не разделитель (иначе «2,117» — два числа). */
const COUNT = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.])(\d+)\s+(${PASS_WORD}|${FAIL_WORD})(?![\p{L}\p{N}_])|` +
    String.raw`(?<![\p{L}\p{N}_])(${PASS_WORD}|${FAIL_WORD})\s*[:=]\s*(\d+)(?![\p{L}\p{N}_.])`,
  'giu',
);
const IS_PASS = new RegExp(`^(?:${PASS_WORD})$`, 'iu');

/** Счёт, названный доказательством; числа — как написаны, по порядку. */
export interface CountClaim {
  passed: number[];
  failed: number[];
  /** Найденные куски текста — для строки пробела. */
  text: string;
}

/** Счёт тестов в тексте; `undefined` — чисел «passed/failed» в нём нет. */
export function countClaimOf(evidence: string): CountClaim | undefined {
  const claim: CountClaim = { passed: [], failed: [], text: '' };
  const pieces: string[] = [];
  for (const match of evidence.matchAll(COUNT)) {
    const word = match[2] ?? match[3] ?? '';
    const value = Number(match[1] ?? match[4]);
    if (!Number.isFinite(value)) continue;
    (IS_PASS.test(word) ? claim.passed : claim.failed).push(value);
    pieces.push(match[0].trim());
  }
  if (pieces.length === 0) return undefined;
  claim.text = pieces.join(', ');
  return claim;
}

/**
 * Счёт ссылается на блок «Тесты» — его сверяют с прогоном: доказательство называет
 * `tests-cli` или ссылается на прогон. Счёт чужой команды без них («pytest 40 passed»)
 * не сверяется: панели не с чем.
 */
export function claimsTestsBlock(evidence: string, cited: readonly string[]): boolean {
  return cited.length > 0 || /\btests-cli\b/i.test(evidence);
}

/** Счёт тестов прогона; `exact: false` — выведен из заметок старой записи, «прошло» неточно. */
export interface RunTestCount {
  passed: number;
  failed: number;
  exact: boolean;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);
/** Одно из названных чисел или их сумма — «12 passed (unit), 40 passed (e2e)» про прогон из 52. */
const fits = (claimed: readonly number[], actual: number): boolean =>
  claimed.includes(actual) || sum(claimed) === actual;

/**
 * Сходится ли счёт с прогоном (или суммой прогонов). Не названное «упало» — ноль:
 * «2117 passed» при одном упавшем — не сходится. Неточный счёт сверяется только
 * «упало ли что-то».
 */
export function countMatches(claim: CountClaim, run: RunTestCount): boolean {
  const failed = claim.failed.length > 0 ? claim.failed : [0];
  if (!run.exact) return Math.max(...failed) > 0 === run.failed > 0;
  if (!fits(failed, run.failed)) return false;
  return claim.passed.length === 0 || fits(claim.passed, run.passed);
}

/** Счёт нескольких прогонов вместе (строка сослалась на прогоны частей). */
export function totalCount(runs: readonly RunTestCount[]): RunTestCount {
  return {
    passed: sum(runs.map((run) => run.passed)),
    failed: sum(runs.map((run) => run.failed)),
    exact: runs.every((run) => run.exact),
  };
}
