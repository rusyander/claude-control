import {
  BUILTIN_SIEVES,
  countClaimOf,
  evidenceRunIds,
  looseRunIds,
  type SieveProofFacts,
  type SieveReportRow,
  type RunTestCount,
  type SieveRunFact,
} from '@agentdeck/contracts/sieves';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { readGroups, readRun, readRuns } from '../../project-tests/project-tests.ts';
import { run } from '../../project-git/sieve-facts/sieve-facts.ts';
import { changedAfter, commitsOf, type BranchCommit } from '../../project-git/sieve-facts-scan.ts';
import { commentOnlyPaths } from './comment-only.ts';

/**
 * Проверяемость отчёта о ситах — то, что превращает «доказательство» из слов в
 * факт, который панель перепроверяет сама:
 *
 * - СВЕЖЕСТЬ: строка сдана в момент `row.at` (штамп панели) на том коде, на
 *   который тогда указывал HEAD копии (reflog). Строку снимает только ДРУГОЕ
 *   содержимое файлов ветки с тех пор (Ф6): «проверил на ревью, потом
 *   переписал» не проходит, а rebase без правок, переписавший время всех
 *   коммитов, строки не трогает. Нет reflog на тот момент — по времени коммитов;
 * - ПРОГОН: живую проверку в проекте с блоком «Тесты» доказывает записанный
 *   прогон блока. Панель открывает его в истории копии: закончен ли, нет ли
 *   красных кейсов, и что менялось в ветке после его коммита.
 */

/** Прогонов на одну доставку не больше этого: ссылки сверх — не доказательство, а шум. */
const RUNS_MAX = 10;

function hasTestsBlock(cwd: string): boolean {
  try {
    return readGroups(cwd).some((group) => group.cases.length > 0);
  } catch {
    return false;
  }
}

/** Что менялось в ветке после коммита прогона; коммита нет в ветке — все её пути. */
async function changedSinceCommit(
  cwd: string,
  commit: string | undefined,
  branchPaths: readonly string[],
): Promise<string[]> {
  if (!commit) return [...branchPaths];
  const ancestor = await run(cwd, ['merge-base', '--is-ancestor', commit, 'HEAD']);
  if (ancestor.code !== 0) return [...branchPaths];
  const diff = await run(cwd, ['diff', '--name-only', '-z', commit, 'HEAD']);
  if (diff.code !== 0) return [...branchPaths];
  const paths = diff.stdout.split('\0').filter(Boolean);
  const quiet = await commentOnlyPaths(cwd, commit, paths);
  return paths.filter((path) => !quiet.has(path));
}

async function runFact(
  cwd: string,
  id: string,
  branchPaths: readonly string[],
  tags: ReadonlyMap<string, readonly string[]>,
  paths: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<SieveRunFact> {
  let record;
  try {
    record = readRun(cwd, id);
  } catch {
    record = undefined;
  }
  if (!record || record.status !== 'done') return { found: false, red: [], changedAfter: [] };
  const red = (record.results ?? [])
    .filter((result) => result.status === 'failed' || result.status === 'blocked')
    .map((result) => result.caseId);
  const green = (record.results ?? []).filter((result) => result.status === 'passed');
  const passed = green.length;
  // Живые метки доказывает только прогон, который панель видела исполненным: ручная
  // запись «passed» (`attested`) — слово агента, и группа g8 сдала ею сито стенда, сама
  // пометив кейс «live/stand» и сама его «пройдя» (split d9869abf, F2).
  const liveTags = new Set(
    record.attested
      ? []
      : green.flatMap((result) => tags.get(`${result.groupId}:${result.caseId}`) ?? []),
  );
  // Файлы исполненных кейсов — живое доказательство диффа из одних инструментов
  // (строка 98): тут свой кейс группы годится, исполнение не слово агента.
  const executedPaths = new Set(
    record.attested
      ? []
      : green.flatMap((result) => paths.get(`${result.groupId}:${result.caseId}`) ?? []),
  );
  return {
    found: true,
    red: [...new Set(red)],
    passed,
    tags: [...liveTags],
    executedPaths: [...executedPaths],
    changedAfter: await changedSinceCommit(cwd, record.commit, branchPaths),
    ...testCountOf(record),
  };
}

/**
 * Счёт тестов прогона: записанный отчётом (`record.tests`) — точный; у старой записи —
 * из заметок кейсов («✓ N», «✗ k/N» кейса-набора, иначе кейс — один тест), и тогда
 * «прошло» неточно. Ручная запись (`attested`) счёта не несёт.
 */
function testCountOf(record: ProjectTestRunRecord): { tests?: RunTestCount } {
  if (record.tests) {
    return { tests: { passed: record.tests.passed, failed: record.tests.failed, exact: true } };
  }
  if (record.attested) return {};
  let passed = 0;
  let failed = 0;
  for (const result of record.results ?? []) {
    const note = result.note ?? '';
    const green = /^✓ (\d+)$/u.exec(note);
    const red = /^✗ (\d+)\/\d+/u.exec(note);
    if (green) passed += Number(green[1]);
    else if (red) failed += Number(red[1]);
    else if (result.status === 'passed') passed += 1;
    else if (result.status === 'failed' || result.status === 'blocked') failed += 1;
  }
  return { tests: { passed, failed, exact: false } };
}

/** Коммит, на который указывал HEAD копии в момент `at` (ISO), — из reflog. */
async function headAt(cwd: string, at: string): Promise<string | undefined> {
  const since = Date.parse(at);
  if (Number.isNaN(since)) return undefined;
  const out = await run(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `HEAD@{@${Math.floor(since / 1000)}}^{commit}`,
  ]);
  return out.code === 0 ? out.stdout.trim() || undefined : undefined;
}

/**
 * Файлы ветки, чьё содержимое в HEAD уже не то, что было в момент `at`.
 * `undefined` — момент не восстановить (reflog пуст или удалён).
 */
async function changedSinceMoment(
  cwd: string,
  at: string,
  branchPaths: readonly string[],
): Promise<string[] | undefined> {
  const snapshot = await headAt(cwd, at);
  if (!snapshot) return undefined;
  const diff = await run(cwd, ['diff', '--name-only', '--no-renames', '-z', snapshot, 'HEAD']);
  if (diff.code !== 0) return undefined;
  // Только файлы самой ветки: то, что rebase принёс из основной в чужие файлы,
  // не код, на котором строка сдана.
  const branch = new Set(branchPaths);
  const paths = diff.stdout.split('\0').filter((path) => path && branch.has(path));
  const quiet = await commentOnlyPaths(cwd, snapshot, paths);
  return paths.filter((path) => !quiet.has(path));
}

/** Факты проверяемости отчёта группы в её копии `cwd`. */
export async function sieveProofFacts(input: {
  cwd: string;
  rows: readonly SieveReportRow[];
  /** Коммиты ветки (из фактов доставки); нет — читаются от `base`. */
  commits?: readonly BranchCommit[];
  base?: string;
  /** Все пути ветки — на случай прогона на коммите не из неё. */
  branchPaths: readonly string[];
  /**
   * Начало работы группы (ISO): кейс агента, тронутый после него, своих живых
   * меток не доказывает (F2). Нет — кейсы агента меток не дают вовсе.
   */
  startedAt?: string;
}): Promise<SieveProofFacts> {
  let commits: readonly BranchCommit[] | undefined = input.commits;
  const byMoment = new Map<string, string[]>();
  const changedAfterRow: Record<string, string[]> = {};
  for (const row of input.rows) {
    if (!row.at) continue;
    let paths = byMoment.get(row.at);
    if (!paths) {
      paths = await changedSinceMoment(input.cwd, row.at, input.branchPaths);
      if (!paths) {
        commits ??= input.base ? await commitsOf(run, input.cwd, input.base) : [];
        paths = changedAfter(commits, row.at);
      }
      byMoment.set(row.at, paths);
    }
    if (paths.length > 0) changedAfterRow[row.id] = paths;
  }
  const testsBlock = hasTestsBlock(input.cwd);
  const runs: Record<string, SieveRunFact> = {};
  let latest: string[] | undefined;
  if (testsBlock) {
    // Живые сита: прогоном (`proof:'run'`) и с живыми метками (стенд ветки).
    const proved = new Set<string>(
      BUILTIN_SIEVES.filter((sieve) => sieve.proof === 'run' || sieve.liveTags).map(
        (sieve) => sieve.id,
      ),
    );
    const tags = caseTags(input.cwd, input.startedAt);
    const paths = casePaths(input.cwd);
    // Строки со счётом тестов (F-12): «2117 passed» судья сверит с прогоном — любого сита.
    const passing = input.rows.filter(
      (row) =>
        row.status === 'pass' && (proved.has(row.id) || countClaimOf(row.evidence) !== undefined),
    );
    // `run:<id>` и свободные формы — свободную судья возьмёт, только если прогон нашёлся.
    const ids = passing.flatMap((row) => [
      ...evidenceRunIds(row.evidence),
      ...looseRunIds(row.evidence),
    ]);
    for (const id of [...new Set(ids)].slice(0, RUNS_MAX)) {
      runs[id] = await runFact(input.cwd, id, input.branchPaths, tags, paths);
    }
    // Строке без ссылки — годный прогон из истории, чтобы на него сослаться.
    if (passing.some((row) => evidenceRunIds(row.evidence).length === 0)) {
      latest = recentRunIds(input.cwd);
      for (const id of latest) runs[id] ??= await runFact(input.cwd, id, input.branchPaths, tags);
    }
  }
  return { changedAfterRow, testsBlock, runs, ...(latest?.length ? { latest } : {}) };
}

/** Последних законченных прогонов, которые панель предложит сослаться, — не больше. */
const LATEST_MAX = 5;

function recentRunIds(cwd: string): string[] {
  try {
    return readRuns(cwd, LATEST_MAX * 2)
      .filter((record) => record.status === 'done')
      .slice(0, LATEST_MAX)
      .map((record) => record.id);
  } catch {
    return [];
  }
}

/**
 * Метки кейсов копии по `<группа>:<кейс>` — в нижнем регистре. Кейс агента,
 * заведённый или правленный после начала работы группы, меток не даёт: метку «live»
 * агент ставит себе сам (F2). Кейс человека агент не правит (его правка — черновик).
 */
function caseTags(cwd: string, startedAt: string | undefined): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  const since = startedAt ? Date.parse(startedAt) : Number.NaN;
  const own = (item: { source: string; updatedAt?: string }): boolean => {
    if (item.source !== 'agent') return false;
    if (Number.isNaN(since)) return true;
    const touched = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
    return Number.isNaN(touched) || touched >= since;
  };
  try {
    for (const group of readGroups(cwd))
      for (const item of group.cases)
        if (item.tags?.length && !own(item))
          tags.set(
            `${group.id}:${item.id}`,
            item.tags.map((tag) => tag.toLowerCase()),
          );
  } catch {
    // Блок не читается — меток нет, живой прогон не доказан.
  }
  return tags;
}

/** `codePaths` каждого кейса копии — и своих кейсов группы: судит их исполнение, не метка. */
function casePaths(cwd: string): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  try {
    for (const group of readGroups(cwd))
      for (const item of group.cases)
        if (item.codePaths?.length) paths.set(`${group.id}:${item.id}`, item.codePaths);
  } catch {
    // Блок не читается — путей нет, инструмент исполненным не доказан.
  }
  return paths;
}
