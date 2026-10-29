import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { foldsCaseAt } from '../../platform/paths.ts';
import type { CaseHit, CaseScope, LinkedCase } from './tests-block.types.ts';

/**
 * Какие кейсы доказала запись проверки и чем (04:65-67, P50, G15). Сопоставление — по
 * `automation.file` + полному `testName` (describe-путь покрывает всё под ним). Запись говорит
 * только о тестах, которые исполнила: кейс вне её охвата прогона не получает. Чего запись не
 * доказывает — кейс без прогона, а не «зелёный по догадке»: красный без имён, упавший тест без
 * файла против кейса на весь файл, обрезанный лог красного, база, повтор, прогон без вердикта.
 */

const slash = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const trimEnd = (p: string): string => p.replace(/\/+$/, '');

/** Тест `name` лежит под `path` (тот же тест или потомок describe-пути). */
const under = (name: string, path: string): boolean =>
  name === path || name.startsWith(`${path} > `);

const insideDir = (file: string, dir: string): boolean => {
  const d = trimEnd(slash(dir));
  return d === '' || file === d || file.startsWith(`${d}/`);
};

/**
 * Путь из вывода раннера — от его cwd; кейс пишет путь от корня проекта. Где том не различает
 * регистр, `A.test.ts` из вывода и `a.test.ts` из кейса — один файл.
 */
function sameFile(reported: string, caseFile: string, cwd: string): boolean {
  const fold = (p: string): string => (foldsCaseAt(undefined) ? p.toLowerCase() : p);
  const r = fold(slash(reported));
  const target = fold(caseFile);
  if (r === target) return true;
  const base = fold(trimEnd(slash(cwd)));
  return base !== '' && `${base}/${r}` === target;
}

const looksLikeFile = (item: string): boolean => /[/\\]|\.[A-Za-z0-9]+$/.test(item);

/** Исполнила ли запись тесты кейса целиком (узкий прогон, вся единица, весь проект). */
export function inRecordScope(rec: CheckRecord, scope: CaseScope, c: LinkedCase): boolean {
  const file = slash(c.file);
  const cwd = scope.entry.cwd;
  if (!insideDir(file, cwd)) return false;
  const selection = rec.parts.selection;
  if (selection.length > 0) {
    const files = selection.filter(looksLikeFile).map(slash);
    const names = selection.filter((s) => !looksLikeFile(s));
    const fileOk = files.length === 0 || files.some((f) => sameFile(f, file, cwd));
    // Узкий прогон по именам покрывает кейс, только если имя кейса целиком под одним из них:
    // прогон части describe кейсу-целому — частичный зелёный.
    const nameOk =
      names.length === 0 || (c.testName !== undefined && names.some((n) => under(c.testName!, n)));
    return fileOk && nameOk;
  }
  if (rec.unit === '.' || scope.entry.unit === 'project') return true;
  const unit = scope.units[rec.unit];
  // Единица, которой нет в реестре, — охват неизвестен: прогона кейсу нет.
  if (!unit) return false;
  return unit.paths.some((p) => insideDir(file, p));
}

/**
 * Тест кейса прошёл — не «единица зелёная»: зелёная единица не доказывает, что тест кейса есть
 * (переименован, удалён). Доказывает список прошедших в записи (у флака — и упавшие в первом
 * заходе) или узкий прогон ровно этого теста. Кейс на весь файл — так же: его файл в списке
 * прошедших или зелёный узкий прогон этого файла. Охват записи файла не доказывает: файл
 * могли удалить, а вывод раннера — не назвать ни одного теста (records.ts `passing`, P50).
 */
function passedProven(rec: CheckRecord, scope: CaseScope, c: LinkedCase): boolean {
  const file = slash(c.file);
  const cwd = scope.entry.cwd;
  const listed =
    rec.verdict.kind === 'pass-flaky' ? [...(rec.passing ?? []), ...rec.failing] : rec.passing;
  if (c.testName === undefined) {
    if (listed?.some((t) => t.file !== undefined && sameFile(t.file, file, cwd))) return true;
    return (
      rec.verdict.kind !== 'fail' &&
      rec.grade === 'narrow' &&
      rec.parts.selection.some((s) => looksLikeFile(s) && sameFile(s, file, cwd))
    );
  }
  const name = c.testName;
  if (listed)
    return listed.some(
      (t) => (t.file === undefined || sameFile(t.file, file, cwd)) && under(t.name, name),
    );
  return rec.grade === 'narrow' && rec.parts.selection.includes(name);
}

/** Записи, которые вообще говорят о кейсах: раннер тестов, финальное содержимое, вердикт есть. */
function speaks(rec: CheckRecord, scope: CaseScope): boolean {
  if (scope.entry.class !== 'test-runner') return false;
  if (rec.grade !== 'unit' && rec.grade !== 'narrow') return false;
  const v = rec.verdict;
  return v.kind === 'pass' || v.kind === 'pass-flaky' || (v.kind === 'fail' && v.reason === 'red');
}

export function caseHits(
  rec: CheckRecord,
  scope: CaseScope,
  cases: readonly LinkedCase[],
): CaseHit[] {
  if (!speaks(rec, scope)) return [];
  const v = rec.verdict;
  // Красный без разобранных имён — упасть мог любой тест единицы: ни одному кейсу не вердикт.
  if (v.kind === 'fail' && rec.failing.length === 0) return [];
  const out: CaseHit[] = [];
  for (const c of cases) {
    if (!inRecordScope(rec, scope, c)) continue;
    const ref = { groupId: c.groupId, caseId: c.caseId };
    if (v.kind === 'pass') {
      if (passedProven(rec, scope, c)) out.push({ ...ref, status: 'passed' });
      continue;
    }
    if (v.kind === 'pass-flaky') {
      if (passedProven(rec, scope, c))
        out.push({ ...ref, status: 'passed', flakyAttempts: v.retries.length });
      continue;
    }
    const file = slash(c.file);
    const mine = rec.failing.filter((f) => {
      if (f.file !== undefined && !sameFile(f.file, file, scope.entry.cwd)) return false;
      if (c.testName === undefined) return f.file !== undefined;
      return under(f.name, c.testName);
    });
    if (mine.length > 0) {
      out.push({
        ...ref,
        status: 'failed',
        failedTests: mine.map((f) => ({ name: f.name, ...(f.file ? { owner: f.file } : {}) })),
      });
      continue;
    }
    // Кейс на весь файл, а упавший тест без файла — мог быть его: вердикта нет.
    if (c.testName === undefined && rec.failing.some((f) => f.file === undefined)) continue;
    // Лог обрезан посередине — падение кейса могло уйти в вырезанное: не названный в списке
    // упавших кейс под красным вердиктом не доказан.
    if (rec.log.truncated) continue;
    if (passedProven(rec, scope, c)) out.push({ ...ref, status: 'passed' });
  }
  return out;
}
