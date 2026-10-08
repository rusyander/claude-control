import type { SieveMechanics } from '@agentdeck/contracts/sieves';
import { projectChecks } from './project-checks.ts';
import {
  artifactsIn,
  debugLeftoversIn,
  declaresEnv,
  destructiveIn,
  envReadsIn,
  lockfileGapsIn,
  secretsIn,
  untestedCodeIn,
  type Addition,
} from './sieve-scan/sieve-scan.ts';

/**
 * Вход механики сит из git копии: добавленные файлы, их размер и то, что их
 * исключает `.gitignore`, файлы репозитория для лок-файлов, объявления новых
 * переменных окружения. Сами решения — в `sieve-scan.ts`, чистыми функциями.
 *
 * `run` приходит из `sieve-facts.ts` (git с кодом выхода и потолками).
 */

type GitRun = (
  cwd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

interface DiffInput {
  removed: { path: string; lines: string[] }[];
  additions: Addition[];
}

/** Потолки: проверка идёт перед каждой доставкой и не должна становиться обходом репо. */
const ENV_NAMES_MAX = 20;
const ADDED_FILES_MAX = 200;

function nul(out: string): string[] {
  return out
    .split('\0')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Добавленные файлы, которые `.gitignore` исключает, и их размер в HEAD. */
async function addedFileFacts(
  run: GitRun,
  cwd: string,
  added: readonly string[],
): Promise<{ ignored: string[]; sizes: Record<string, number> }> {
  if (added.length === 0) return { ignored: [], sizes: {} };
  const ignored = await run(cwd, ['check-ignore', '--no-index', '-z', '--', ...added]);
  const tree = await run(cwd, ['ls-tree', '-r', '-l', '-z', 'HEAD', '--', ...added]);
  const sizes: Record<string, number> = {};
  for (const entry of nul(tree.stdout)) {
    const match = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(entry);
    if (match) sizes[match[2]!] = Number(match[1]);
  }
  return { ignored: ignored.code === 0 ? nul(ignored.stdout) : [], sizes };
}

/** Новые переменные окружения, не объявленные ни в конфигурации, ни в доках. */
async function undeclaredEnv(
  run: GitRun,
  cwd: string,
  additions: readonly Addition[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of envReadsIn(additions).slice(0, ENV_NAMES_MAX)) {
    const found = await run(cwd, ['grep', '-l', '-w', '-F', '-e', name, 'HEAD', '--']);
    const files = found.code === 0 ? found.stdout.split('\n').map((line) => line.trim()) : [];
    const declared = files
      .map((line) => line.replace(/^HEAD:/, ''))
      .filter(Boolean)
      .some(declaresEnv);
    if (!declared) missing.push(name);
  }
  return missing;
}

/** Механика сит по ветке от развилки `base`: только найденное, без пустых полей. */
export async function scanMechanics(input: {
  run: GitRun;
  cwd: string;
  base: string;
  paths: readonly string[];
  diff: DiffInput;
}): Promise<SieveMechanics> {
  const { run, cwd, base, paths, diff } = input;
  const removedLines: Addition[] = diff.removed.flatMap((hunk) =>
    hunk.lines.map((text) => ({ path: hunk.path, text })),
  );
  const [addedOut, trackedOut] = await Promise.all([
    run(cwd, ['diff', '--name-only', '-z', '--diff-filter=A', base, 'HEAD']),
    run(cwd, ['ls-files', '-z']),
  ]);
  const added = nul(addedOut.stdout).slice(0, ADDED_FILES_MAX);
  const facts = await addedFileFacts(run, cwd, added);

  const found: SieveMechanics = {
    secrets: secretsIn(diff.additions),
    debugLeftovers: debugLeftoversIn(diff.additions),
    lockfiles: lockfileGapsIn({
      changed: paths,
      lines: [...diff.additions, ...removedLines],
      tracked: nul(trackedOut.stdout),
    }),
    artifacts: artifactsIn({ added, ...facts }),
    envVars: await undeclaredEnv(run, cwd, diff.additions),
    untestedCode: untestedCodeIn(paths),
    destructive: destructiveIn(diff.additions),
    checks: projectChecks(cwd),
  };
  return Object.fromEntries(
    Object.entries(found).filter(([, value]) => Array.isArray(value) && value.length > 0),
  ) as SieveMechanics;
}

/** Коммит ветки: время коммита (мс) и его файлы. */
export interface BranchCommit {
  at: number;
  paths: string[];
}

/** Коммиты ветки от развилки, новые первыми. */
export async function commitsOf(run: GitRun, cwd: string, base: string): Promise<BranchCommit[]> {
  const log = await run(cwd, [
    'log',
    '--no-renames',
    '--format=%x1e%ct',
    '--name-only',
    `${base}..HEAD`,
  ]);
  if (log.code !== 0) return [];
  return log.stdout
    .split('\x1e')
    .map((block) => block.split('\n').map((line) => line.trim()))
    .filter((lines) => /^\d+$/.test(lines[0] ?? ''))
    .map((lines) => ({ at: Number(lines[0]) * 1000, paths: lines.slice(1).filter(Boolean) }));
}

/** Файлы, изменённые коммитами ветки ПОСЛЕ момента `at` (ISO). */
export function changedAfter(commits: readonly BranchCommit[], at: string): string[] {
  const since = Date.parse(at);
  if (Number.isNaN(since)) return [];
  return [
    ...new Set(commits.filter((commit) => commit.at > since).flatMap((commit) => commit.paths)),
  ];
}
