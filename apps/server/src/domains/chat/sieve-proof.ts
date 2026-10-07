import {
  BUILTIN_SIEVES,
  evidenceRunIds,
  type SieveProofFacts,
  type SieveReportRow,
  type SieveRunFact,
} from '@agentdeck/contracts/sieves';
import { readGroups, readRun } from '../project-tests.ts';
import { run } from '../project-git/sieve-facts.ts';
import { changedAfter, commitsOf, type BranchCommit } from '../project-git/sieve-facts-scan.ts';

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
  return diff.stdout.split('\0').filter(Boolean);
}

async function runFact(
  cwd: string,
  id: string,
  branchPaths: readonly string[],
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
  const passed = (record.results ?? []).filter((result) => result.status === 'passed').length;
  return {
    found: true,
    red: [...new Set(red)],
    passed,
    changedAfter: await changedSinceCommit(cwd, record.commit, branchPaths),
  };
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
  return diff.stdout.split('\0').filter((path) => path && branch.has(path));
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
  if (testsBlock) {
    const proved = new Set<string>(
      BUILTIN_SIEVES.filter((sieve) => sieve.proof === 'run').map((sieve) => sieve.id),
    );
    const ids = input.rows
      .filter((row) => proved.has(row.id) && row.status === 'pass')
      .flatMap((row) => evidenceRunIds(row.evidence));
    for (const id of [...new Set(ids)].slice(0, RUNS_MAX)) {
      runs[id] = await runFact(input.cwd, id, input.branchPaths);
    }
  }
  return { changedAfterRow, testsBlock, runs };
}
