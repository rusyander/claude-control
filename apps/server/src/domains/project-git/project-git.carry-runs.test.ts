import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { addWorktree, removeWorktree } from './project-git.ts';
import { codeOf } from '../../lib/server-text/server-text.ts';

/**
 * F-5: прогоны блока «Тесты», сделанные в копии ветки, переживают её удаление —
 * на НАСТОЯЩЕМ `git worktree`. Хранилище едет в копию зеркалом, группа пишет
 * свои прогоны туда; удаление копии раньше уносило их с собой.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp.
  }
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

const RUNS = ['.agent', 'tests', 'runs'];

function run(id: string, startedAt: string, attachments: string[] = []) {
  return {
    id,
    mode: 'import',
    actor: 'ci',
    origin: 'e2e',
    scope: 'группа',
    exitCode: 0,
    status: 'done',
    startedAt,
    finishedAt: startedAt,
    results: [{ caseId: 'login-001', status: 'passed', attachments }],
    summary: { total: 1, passed: 1, failed: 0, blocked: 0, skipped: 0, untested: 0 },
  };
}

function writeRunFile(root: string, name: string, data: unknown): void {
  mkdirSync(join(root, ...RUNS), { recursive: true });
  writeFileSync(
    join(root, ...RUNS, `${name}.run.json`),
    typeof data === 'string' ? data : JSON.stringify(data),
  );
}

const runNames = (root: string): string[] =>
  existsSync(join(root, ...RUNS)) ? readdirSync(join(root, ...RUNS)).sort() : [];

describe.skipIf(!hasGit())('копия ветки: прогоны блока «Тесты» при удалении', () => {
  let dir = '';
  let siblings = '';
  let home = '';
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-carry-home-'));
    for (const key of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL'] as const)
      saved[key] = process.env[key];
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = join(home, 'gitconfig');
    writeFileSync(join(home, 'gitconfig'), '');
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-carry-')));
    siblings = join(dirname(dir), `${basename(dir)}-worktrees`);
    gitIn(dir, 'init', '--initial-branch=main');
    gitIn(dir, 'config', 'user.email', 'test@example.invalid');
    gitIn(dir, 'config', 'user.name', 'Test');
    gitIn(dir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\n');
    writeFileSync(join(dir, 'app.txt'), 'app\n');
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-m', 'init');
    // Прогон основного — он уедет в копию зеркалом и не должен вернуться дублем.
    writeRunFile(dir, '20261001100000-aaaa0001', run('aaaa0001-root', '2026-10-01T10:00:00.000Z'));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    dropTemp(siblings);
    dropTemp(dir);
    dropTemp(home);
  });

  it('прогон группы и его вложение переезжают в основной, свой прогон основного не дублируется', async () => {
    const copy = (await addWorktree(dir, 'feature/group')).path;
    expect(runNames(copy)).toEqual(['20261001100000-aaaa0001.run.json']);

    const shot = '.agent/tests/attachments/login-001/20261002120000-after.png';
    mkdirSync(dirname(join(copy, ...shot.split('/'))), { recursive: true });
    writeFileSync(join(copy, ...shot.split('/')), 'png');
    writeRunFile(
      copy,
      '20261002120000-bbbb0002',
      run('bbbb0002-group', '2026-10-02T12:00:00.000Z', [shot]),
    );

    const out = await removeWorktree(dir, copy);

    expect(existsSync(copy)).toBe(false);
    expect(runNames(dir)).toEqual([
      '20261001100000-aaaa0001.run.json',
      '20261002120000-bbbb0002.run.json',
    ]);
    const moved = JSON.parse(
      readFileSync(join(dir, ...RUNS, '20261002120000-bbbb0002.run.json'), 'utf8'),
    );
    expect(moved.id).toBe('bbbb0002-group');
    expect(readFileSync(join(dir, ...shot.split('/')), 'utf8')).toBe('png');
    expect(out.outputCode).toBe('worktree-removed-runs');
    expect(out.outputParams).toMatchObject({ runs: '1' });
  });

  it('прогон, уже записанный в основном, не переписывается копией', async () => {
    const copy = (await addWorktree(dir, 'feature/same')).path;
    writeRunFile(
      copy,
      '20261001100000-aaaa0001',
      run('aaaa0001-root', '2026-10-01T10:00:00.000Z', ['подмена']),
    );

    const out = await removeWorktree(dir, copy);

    const own = JSON.parse(
      readFileSync(join(dir, ...RUNS, '20261001100000-aaaa0001.run.json'), 'utf8'),
    );
    expect(own.results[0].attachments).toEqual([]);
    expect(out.outputCode).toBe('worktree-removed');
  });

  it('битая запись в копии удалению не мешает — переносить нечего', async () => {
    const copy = (await addWorktree(dir, 'feature/broken')).path;
    writeRunFile(copy, '20261003090000-cccc0003', '{ не json');

    const out = await removeWorktree(dir, copy);

    expect(existsSync(copy)).toBe(false);
    expect(runNames(dir)).toEqual(['20261001100000-aaaa0001.run.json']);
    expect(out.outputCode).toBe('worktree-removed');
  });

  it('записать в основной не вышло — копия остаётся, отказ с кодом', async () => {
    const copy = (await addWorktree(dir, 'feature/locked')).path;
    writeRunFile(
      copy,
      '20261004090000-dddd0004',
      run('dddd0004-group', '2026-10-04T09:00:00.000Z'),
    );
    // Каталог прогонов основного подменён файлом: запись туда невозможна.
    dropTemp(join(dir, ...RUNS));
    writeFileSync(join(dir, ...RUNS), 'не каталог');

    const failure = await removeWorktree(dir, copy).catch((error: unknown) => error);

    expect(codeOf(failure).messageCode).toBe('worktree-runs-carry-failed');
    expect(existsSync(join(copy, ...RUNS, '20261004090000-dddd0004.run.json'))).toBe(true);
  });
});
