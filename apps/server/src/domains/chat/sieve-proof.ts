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
 * - СВЕЖЕСТЬ: строка сдана в момент `row.at` (штамп панели), и коммиты ветки
 *   после него, задевшие код сита, её снимают — «проверил на ревью, потом
 *   переписал» больше не проходит;
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
  const commits = input.commits ?? (input.base ? await commitsOf(run, input.cwd, input.base) : []);
  const changedAfterRow: Record<string, string[]> = {};
  for (const row of input.rows) {
    if (!row.at) continue;
    const paths = changedAfter(commits, row.at);
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
