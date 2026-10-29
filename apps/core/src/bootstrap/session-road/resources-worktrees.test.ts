import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SessionHandle } from '../../adapters/index.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps } from '../../journal/__fixtures__/journal-harness.ts';
import { listWorktrees } from '../../platform/resource-scan.ts';
import {
  releaseTaskResources,
  scanAfterStop,
  takeBaseline,
  type ResourceReaders,
} from './resources.ts';

/**
 * Рабочие копии, найденные за шаг (P90, ревью B2r4-F01): `git worktree list` — список ВСЕГО
 * репозитория, окно времени шага — не авторство. Копия параллельной задачи (создана ядром за шаг)
 * не находка сессии; копия с несохранённой работой в конце задачи не снимается `--force`, а
 * остаётся утечкой с причиной. Настоящий git во временной папке.
 */

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const got = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (got.status !== 0) throw new Error(`git ${args.join(' ')}: ${got.stderr}`);
}

const readers: ResourceReaders = {
  worktrees: (repo) => listWorktrees(repo),
  containers: async () => ({ value: [] }),
  listeners: async () => ({ value: [] }),
  sweep: async () => ({ value: [] }),
};

describe('worktrees found at step end belong to the session, not to the time window', () => {
  it("another live task's copy added during the step is not found and survives; a dirty session copy is kept as a leak", async () => {
    const fx = mkdtempSync(join(tmpdir(), 'agentdeck-wt-'));
    temps.push(fx);
    const main = join(fx, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    git(main, 'add', '.');
    git(main, 'commit', '-q', '-m', 'init');
    const copyA = join(fx, 'taskA-copy');
    git(main, 'worktree', 'add', '-q', '-b', 'a', copyA);

    const registry = createTaskRegistry(join(fx, 'tasks'), deps());
    const task = await registry.create(CREATED);
    const session = seedSession(task, { stepKind: 'work' });
    const dir = join(fx, 'session');
    mkdirSync(dir);
    const baseline = await takeBaseline(
      { task, sessionId: session.sessionId, stateDir: join(fx, 'state'), cwd: copyA, engines: [] },
      readers,
    );
    // За шаг: ядро создаёт копию задачи B (с её работой), сессия A — свою копию с правкой.
    const copyB = join(fx, 'taskB-copy');
    git(main, 'worktree', 'add', '-q', '-b', 'b', copyB);
    writeFileSync(join(copyB, 'b-work.txt'), 'B uncommitted\n');
    const scratch = join(fx, 'scratch');
    git(main, 'worktree', 'add', '-q', '-b', 'scratch', scratch);
    writeFileSync(join(scratch, 'notes.txt'), 'session notes\n');

    const handle = { sessionId: session.sessionId, dir, host: { pid: 1, start: 'x' } };
    const out = await scanAfterStop(
      {
        task,
        handle: handle as unknown as SessionHandle,
        tmpDir: join(dir, 'none'),
        readers,
        note: () => undefined,
        baseline: { value: baseline },
        liveCopies: [copyB],
      },
      { ports: [], unread: [] },
      { how: 'exited', residual: [] },
    );
    const copies = out.found
      .filter((f) => f.kind === 'copy')
      .map((f) => (JSON.parse(f.ref) as { worktree: string }).worktree);
    expect(copies.some((p) => p.endsWith('taskB-copy'))).toBe(false);
    expect(copies.some((p) => p.endsWith('scratch'))).toBe(true);

    const released = await releaseTaskResources(task, { liveCopies: [copyB] });
    registry.closeAll();
    expect(existsSync(join(copyB, 'b-work.txt'))).toBe(true);
    expect(existsSync(join(scratch, 'notes.txt'))).toBe(true);
    expect(released.verified).toEqual([]);
    expect(released.leaks.map((l) => l.reason)).toEqual([
      expect.stringMatching(/scratch has 1 uncommitted path\(s\) — left for the human$/),
    ]);
  });
});
