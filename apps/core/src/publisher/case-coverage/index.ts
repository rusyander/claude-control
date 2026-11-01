import type { Fact } from '@agentdeck/contracts/core/facts';
import type { CaseCodePaths } from '../../platform/tests-store.ts';

/**
 * Карта покрытия кейсами (G18, 04:83): изменённый файл покрыт, если хоть один кейс блока тестов
 * называет его в `codePaths` — сам файл или каталог над ним (то же правило, что у панели). Итог
 * (`conductor/outcomes/final-gate.ts`) отдаёт покрытые файлы в `compose`; непокрытые — пробелы.
 */

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/** `codePath` кейса накрывает файл: совпадение или префикс каталога (не части имени). */
export function pathCovers(codePath: string, file: string): boolean {
  const needle = norm(codePath);
  if (needle === '') return false;
  const target = norm(file);
  return target === needle || target.startsWith(`${needle}/`);
}

/** Файл → кейсы `<группа>:<id>`, которые его называют; файл без кейсов в карту не входит. */
export function casesByFile(
  changed: readonly string[],
  cases: readonly CaseCodePaths[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const file of changed) {
    const ids = cases
      .filter((c) => c.codePaths.some((p) => pathCovers(p, file)))
      .map((c) => `${c.groupId}:${c.caseId}`);
    if (ids.length > 0) map[file] = ids;
  }
  return map;
}

/**
 * Карта «изменённый файл → кейсы»: блока тестов нет или он не читается — `unknown` с причиной,
 * никогда «покрыто». Её отдаёт итог наружу (`FinalGateOutcome.coverage`) — причина не теряется.
 */
export function coverageMap(
  changed: readonly string[],
  store: Fact<CaseCodePaths[]>,
  project: string,
): Fact<Record<string, string[]>> {
  if ('absent' in store) return { unknown: `no tests block in ${project} (.agent/tests absent)` };
  if (!('value' in store)) return { unknown: `tests block of ${project}: ${store.unknown}` };
  return { value: casesByFile(changed, store.value) };
}

/**
 * Факт `covered` для `compose`: покрытые файлы; `unknown` — при `coverage: warn` каждый исходник
 * назван пробелом, при `require` — отказ.
 */
export function coveredFact(
  changed: readonly string[],
  store: Fact<CaseCodePaths[]>,
  project: string,
): Fact<string[]> {
  const map = coverageMap(changed, store, project);
  return 'value' in map ? { value: Object.keys(map.value) } : map;
}
