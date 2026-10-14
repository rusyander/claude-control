import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DockerExec } from '../../compose/docker.ts';
import { closeReviewGroup, statusPaths } from './review-close.ts';

/**
 * Закрытие группы ревью (T13, T6/T11) на настоящем git: репозиторий, копия
 * группы и временные копии во временном каталоге. Граница — только docker.
 */

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста не влияет.
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe('statusPaths', () => {
  it('переименование отдаёт новый путь и пропускает прежний', () => {
    const out = ['R  new.ts', 'old.ts', ' M a.ts', '?? b.ts', ''].join('\0');
    expect(statusPaths(out)).toEqual(['new.ts', 'a.ts', 'b.ts']);
  });
});

describe('закрытие группы ревью', () => {
  let root: string;
  let main: string;
  let copy: string;
  let removedContainers: string[][];

  const run = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  const docker: DockerExec = async (args) => {
    removedContainers.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-review-close-')));
    removedContainers = [];
    main = join(root, 'repo');
    mkdirSync(main);
    run(main, 'init', '-b', 'main');
    run(main, 'config', 'user.email', 'a@example.com');
    run(main, 'config', 'user.name', 'a');
    run(main, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    run(main, 'add', '.');
    run(main, 'commit', '-m', 'one');
    copy = join(root, 'repo-worktrees', 'review');
    run(main, 'worktree', 'add', '-b', 'review/mr', copy);
  });
  afterEach(() => {
    try {
      run(main, 'worktree', 'prune');
    } catch {
      // Репозиторий уже убран — нечего чистить.
    }
    dropTemp(root);
  });

  it('T13: правка и неотслеженный файл — на карточку; своё панели (node_modules, .venv) — нет', async () => {
    writeFileSync(join(copy, 'a.txt'), 'changed\n');
    writeFileSync(join(copy, 'notes.md'), 'scratch\n');
    mkdirSync(join(copy, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(copy, 'node_modules', 'x', 'i.js'), '');
    mkdirSync(join(copy, 'svc', '.venv'), { recursive: true });
    writeFileSync(join(copy, 'svc', '.venv', 'pyvenv.cfg'), '');

    const close = await closeReviewGroup(
      { mainDir: main, copy, startedAt: new Date().toISOString(), knownCopies: [copy] },
      { docker },
    );

    expect(close?.dirt?.total).toBe(2);
    expect(close?.dirt?.files.sort()).toEqual(['a.txt', 'notes.md']);
  });

  it('чистая копия и нечего убирать — итога нет', async () => {
    const close = await closeReviewGroup(
      { mainDir: main, copy, startedAt: new Date().toISOString(), knownCopies: [copy] },
      { docker },
    );
    expect(close).toBeUndefined();
  });

  it('T6/T11: временная копия без правок снимается вместе с каталогом; копия группы, старая и с веткой — остаются', async () => {
    // Копия, заведённая ДО старта группы, — не её.
    const older = join(root, 'repo-worktrees', 'older');
    run(main, 'worktree', 'add', '--detach', older, 'HEAD');
    await sleep(80);
    const startedAt = new Date().toISOString();
    await sleep(80);

    const scratch = join(root, 'review-scratch');
    run(main, 'worktree', 'add', '--detach', scratch, 'HEAD');
    writeFileSync(join(scratch, '_b1r4'), 'линия дописала файл\n');
    const dirty = join(root, 'review-dirty');
    run(main, 'worktree', 'add', '--detach', dirty, 'HEAD');
    writeFileSync(join(dirty, 'a.txt'), 'edited tracked file\n');
    const branched = join(root, 'review-branch');
    run(main, 'worktree', 'add', '-b', 'scratch/b', branched);

    const close = await closeReviewGroup(
      { mainDir: main, copy, startedAt, knownCopies: [copy] },
      { docker },
    );

    expect(close?.scratchRemoved).toHaveLength(1);
    expect(close?.scratchRemoved?.[0]).toMatch(/review-scratch$/);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(copy)).toBe(true);
    expect(existsSync(older)).toBe(true);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(branched)).toBe(true);
    const kept = Object.fromEntries(
      (close?.scratchKept ?? []).map((item) => [item.path.replace(/^.*[\\/]/, ''), item.why]),
    );
    expect(kept['review-dirty']).toContain('uncommitted changes');
    expect(kept['review-branch']).toContain('scratch/b');
    expect(kept.older).toBeUndefined();
    // Репозиторий после уборки знает ровно три копии, не считая снятую.
    const left = run(main, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    expect(left).toHaveLength(5);
  });

  it('копия с коммитами без ветки остаётся: их больше нигде нет', async () => {
    await sleep(80);
    const startedAt = new Date().toISOString();
    await sleep(80);
    const lonely = join(root, 'review-lonely');
    run(main, 'worktree', 'add', '--detach', lonely, 'HEAD');
    run(lonely, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(lonely, 'b.txt'), 'two\n');
    run(lonely, 'add', '.');
    run(lonely, '-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-m', 'only here');

    const close = await closeReviewGroup(
      { mainDir: main, copy, startedAt, knownCopies: [copy] },
      { docker },
    );

    expect(close?.scratchRemoved).toBeUndefined();
    expect(close?.scratchKept?.[0]?.why).toContain('on no branch');
    expect(existsSync(lonely)).toBe(true);
  });

  it('T7: одноразовая база снимается по имени, чужие имена — нет', async () => {
    const close = await closeReviewGroup(
      {
        mainDir: main,
        copy,
        startedAt: new Date().toISOString(),
        knownCopies: [copy],
        stand: { name: 'agentdeck-review-abc123' },
      },
      { docker },
    );
    expect(close?.standRemoved).toBe(true);
    expect(removedContainers).toEqual([['rm', '-f', 'agentdeck-review-abc123']]);

    removedContainers = [];
    const foreign = await closeReviewGroup(
      {
        mainDir: main,
        copy,
        startedAt: new Date().toISOString(),
        knownCopies: [copy],
        stand: { name: 'prod-database' },
      },
      { docker },
    );
    expect(foreign?.standRemoved).toBeUndefined();
    expect(removedContainers).toEqual([]);
  });
});
