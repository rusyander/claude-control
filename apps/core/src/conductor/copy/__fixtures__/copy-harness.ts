import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Profile } from '@agentdeck/contracts/core/records';
import { copyWiring } from '../../../bootstrap/copy-wiring.ts';
import {
  CREATED,
  openFresh,
  SOLO_UNIT,
  tempDir,
} from '../../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../../journal/read-lines.ts';
import type { LiveTask } from '../../../journal/resume.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import type { InstallOutcome, InstallSpec } from '../../../platform/install-run.ts';

/**
 * Общая сцена тестов копии единицы: настоящий git во временном репозитории, задача с единицей в
 * журнале, ядро через `copyWiring` — тот же вход, что у дирижёра. Подменён только запуск
 * установщика (внешняя граница: сеть реестра пакетов).
 */

export const LOCK = 'lockfileVersion: 9.0\n';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/**
 * Репозиторий: база A (закреплена задачей) и B поверх неё — копия обязана встать на A. `tracked` —
 * дополнительные отслеживаемые файлы базы (путь → содержимое).
 */
export function makeRepo(tracked: Record<string, string> = {}): {
  repo: string;
  base: string;
  head: string;
} {
  const repo = join(tempDir('cp-'), 'proj');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.env.local\nsecrets.txt\nnode_modules/\n');
  writeFileSync(join(repo, 'package.json'), '{"name":"p"}\n');
  writeFileSync(join(repo, 'pnpm-lock.yaml'), LOCK);
  for (const [path, text] of Object.entries(tracked)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'A');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'later.txt'), 'B\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'B');
  const head = git(repo, 'rev-parse', 'HEAD');
  // Локальный слой основной копии: из списка, вне списка, окружение сборки.
  writeFileSync(join(repo, '.env.local'), 'FEATURE_FLAG=1\n');
  writeFileSync(join(repo, 'secrets.txt'), 'not listed\n');
  mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'x', 'index.js'), '');
  return { repo, base, head };
}

export async function taskWithUnit(
  repo: string,
  baseRef: string,
): Promise<{ task: LiveTask; unitId: string; branch: string }> {
  const { task } = await openFresh();
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: { ...CREATED, repos: [{ repoKey: 'r1', path: repo, baseRef }] },
  });
  const unitId = newId();
  const branch = `agentdeck/${unitId.slice(-8)}`;
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: { unitId, repoKey: 'r1', branch, ownedPaths: [], ...SOLO_UNIT },
  });
  return { task, unitId, branch };
}

export const PROFILE = {
  value: { stacks: [{ stack: 'js-ts', root: '' }], packageManager: null } as unknown as Profile,
};

/**
 * «pnpm install»: ставит модуль и переписывает lock-файл, как делает настоящий установщик;
 * `rewrites` — ещё lock-файлы глубже корня, которые он переписывает.
 */
export function installer(outcome: Partial<InstallOutcome> = {}, rewrites: string[] = []) {
  const calls: InstallSpec[] = [];
  const install = async (spec: InstallSpec): Promise<InstallOutcome> => {
    calls.push(spec);
    mkdirSync(join(spec.cwd, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(spec.cwd, 'pnpm-lock.yaml'), `${LOCK}# rewritten by install\n`);
    for (const rel of rewrites) writeFileSync(join(spec.cwd, rel), '# rewritten by install\n');
    return { exit: 0, timedOut: false, ms: 5, output: 'Done', ...outcome };
  };
  return { calls, install };
}

export function wiring(
  task: LiveTask,
  root: string,
  install: ReturnType<typeof installer>['install'],
  profile: typeof PROFILE = PROFILE,
) {
  return copyWiring({
    registry: { live: (id) => (id === task.taskId ? task : undefined) },
    layout: { logs: join(root, 'logs') },
    profileOf: async () => profile,
    root: join(root, 'copies'),
    install,
    env: async () => ({ PATH: process.env.PATH ?? '' }),
  });
}

export function decisions(task: LiveTask): { class?: string; output?: { verdict: string } }[] {
  return readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'decision')
    .map((l) => l.data as { class?: string; output?: { verdict: string } });
}

/** Каталог копии ветки под корнем `wiring` (до настоящего пути). */
export function copyPathOf(root: string, branch: string): string {
  return join(root, 'copies', branch.replace('/', '-'));
}
