import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { afterAll, describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { pathKey } from '../../platform/paths.ts';
import {
  compareProtectedRoots,
  protectedRootsAtStepEnd,
  snapshotProtectedRoots,
  type ProtectedRootsInput,
} from './protected-roots.ts';

/**
 * P04, половина «эффект» (06:105-107, G19): настоящий git-репозиторий во временной папке —
 * основная копия, соседняя копия, своя копия задачи — и каталог слоя CLI. Шаг пишет в свою
 * копию (не находка) и разрушает вне её: новый файл в основной копии, коммит в соседней,
 * правка навыка, правка файла учётных данных того же размера (только mtime). Каждое — сигнал
 * `protected-root` со `stop`; изменчивый путь и своя копия — нет. Непрочитанный корень — не
 * «чисто», а `protected-root-unread`.
 */

const temps: string[] = [];
let currentRoot = '';
/** Путь от корня фикстуры: git пишет длинную форму с `/`, temp бывает короткой 8.3 с `\`. */
const rel = (p: string) => relative(pathKey(currentRoot), pathKey(p)).replace(/\\/g, '/');
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const got = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (got.status !== 0) throw new Error(`git ${args.join(' ')}: ${got.stderr}`);
  return got.stdout;
}

function fixture(): {
  root: string;
  input: ProtectedRootsInput;
  main: string;
  sibling: string;
  own: string;
  skills: string;
  cred: string;
  cache: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-roots-'));
  temps.push(root);
  currentRoot = root;
  const main = join(root, 'repo');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'init');
  const sibling = join(root, 'sibling');
  const own = join(root, 'own');
  git(main, 'worktree', 'add', '-q', '-b', 'sib', sibling);
  git(main, 'worktree', 'add', '-q', '-b', 'own', own);
  const config = join(root, 'cli-config');
  const skills = join(config, 'skills');
  const cache = join(config, 'skills', 'cache');
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(skills, 'review.md'), 'skill v1\n');
  const cred = join(config, '.credentials.json');
  writeFileSync(cred, '{"t":"aaaa"}');
  return {
    root,
    main,
    sibling,
    own,
    skills,
    cred,
    cache,
    input: {
      repo: own,
      ownCopy: own,
      layer: { dirs: [skills], credentials: [cred] },
      volatile: [cache],
    },
  };
}

describe('P04 protected roots at step end (real git repo, real config dir)', () => {
  it('a step that only writes its own copy and volatile paths → no finding, no signal', async () => {
    const f = fixture();
    const { task } = await openFresh();
    const before = await snapshotProtectedRoots(f.input);
    expect(before).toMatchObject({ value: { siblings: expect.any(Object) } });
    if ('value' in before) expect(Object.keys(before.value.siblings).map(rel)).toEqual(['sibling']);
    writeFileSync(join(f.own, 'work.ts'), 'export {};\n');
    git(f.own, 'add', '.');
    git(f.own, 'commit', '-q', '-m', 'step work');
    writeFileSync(join(f.cache, 'index.json'), '{}');
    expect(await protectedRootsAtStepEnd(task, before, f.input)).toEqual({ value: [] });
    expect(readJournalLines(task.dir, task.taskId).lines.map((l) => l.kind)).not.toContain(
      'signal',
    );
    task.close();
  });
  it('destructive effects outside the copy → one stop signal per path', async () => {
    const f = fixture();
    const { task } = await openFresh();
    const before = await snapshotProtectedRoots(f.input);
    writeFileSync(join(f.main, 'dropped.sql'), 'drop\n');
    writeFileSync(join(f.sibling, 'b.txt'), 'b\n');
    git(f.sibling, 'add', '.');
    git(f.sibling, 'commit', '-q', '-m', 'foreign');
    writeFileSync(join(f.skills, 'review.md'), 'skill v2 rewritten\n');
    // Тот же размер, другой mtime: ловится списком mtime, а не размером.
    writeFileSync(f.cred, '{"t":"bbbb"}');
    utimesSync(f.cred, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    const got = await protectedRootsAtStepEnd(task, before, f.input);
    expect(got).toMatchObject({ value: expect.any(Array) });
    if (!('value' in got)) return;
    expect(got.value.map((x) => `${x.root} ${x.change} ${rel(x.path)}`).sort()).toEqual(
      [
        'main-checkout status repo/dropped.sql',
        'sibling-copy head sibling',
        'config-dir mtime cli-config/skills/review.md',
        'config-dir mtime cli-config/.credentials.json',
      ].sort(),
    );
    const signals = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) => l.kind === 'signal',
    ) as JournalLine<'signal'>[];
    expect(signals).toHaveLength(4);
    expect(
      signals.every((s) => s.data.signal === 'protected-root' && s.data.severity === 'stop'),
    ).toBe(true);
    task.close();
  });
  it('a step that runs in the main checkout itself: its writes there are its work; a sibling stays protected', async () => {
    const f = fixture();
    const { task } = await openFresh();
    const input: ProtectedRootsInput = { ...f.input, repo: f.main, ownCopy: f.main };
    const before = await snapshotProtectedRoots(input);
    writeFileSync(join(f.main, 'work.ts'), 'export {};\n');
    writeFileSync(join(f.sibling, 'b.txt'), 'b\n');
    const got = await protectedRootsAtStepEnd(task, before, input);
    expect(got).toMatchObject({ value: expect.any(Array) });
    if (!('value' in got)) return;
    expect(got.value.map((x) => `${x.root} ${x.change} ${rel(x.path)}`)).toEqual([
      'sibling-copy status sibling/b.txt',
    ]);
    task.close();
  });
  it('already-dirty paths of the main checkout: deleted, emptied, truncated, staged → one finding each', async () => {
    const f = fixture();
    const { task } = await openFresh();
    writeFileSync(join(f.main, 'gone.ts'), 'gone v1\n');
    writeFileSync(join(f.main, 'work.ts'), 'work v1\n');
    git(f.main, 'add', '.');
    git(f.main, 'commit', '-q', '-m', 'more');
    // Несохранённая работа человека в основной копии — до шага.
    writeFileSync(join(f.main, 'gone.ts'), 'gone v2 — hours of edits\n');
    writeFileSync(join(f.main, 'work.ts'), 'work v2 — hours of edits\n');
    writeFileSync(join(f.main, 'README.md'), 'x edited\n');
    writeFileSync(join(f.main, 'notes.txt'), 'untracked notes\n');
    const before = await snapshotProtectedRoots(f.input);
    rmSync(join(f.main, 'gone.ts'));
    writeFileSync(join(f.main, 'work.ts'), '');
    writeFileSync(join(f.main, 'notes.txt'), '');
    git(f.main, 'add', 'README.md');
    const got = await protectedRootsAtStepEnd(task, before, f.input);
    expect(got).toMatchObject({ value: expect.any(Array) });
    if (!('value' in got)) return;
    expect(got.value.map((x) => `${x.root} ${x.change} ${rel(x.path)}`).sort()).toEqual(
      [
        // `rel` идёт через pathKey: регистр сложен там, где его складывает ОС (Windows), на Linux — как есть.
        `main-checkout status ${rel(join(f.main, 'README.md'))}`,
        'main-checkout status repo/gone.ts',
        'main-checkout status repo/notes.txt',
        'main-checkout status repo/work.ts',
      ].sort(),
    );
    task.close();
  });
  it('a sibling copy removed and a new one added are findings; a new skill file is added', () => {
    const base = { head: 'a', status: {} };
    expect(
      compareProtectedRoots(
        { main: { path: '/m', ...base }, siblings: { '/s1': base }, config: { '/c/a': '1:1' } },
        {
          main: { path: '/m', ...base },
          siblings: { '/s2': base },
          config: { '/c/a': '1:1', '/c/b': '2:2' },
        },
      ),
    ).toEqual([
      { root: 'sibling-copy', path: '/s1', change: 'removed' },
      { root: 'sibling-copy', path: '/s2', change: 'added' },
      { root: 'config-dir', path: '/c/b', change: 'added' },
    ]);
  });
  it('unreadable root → unknown + protected-root-unread warn, never "nothing changed"', async () => {
    const { task } = await openFresh();
    const missing = join(tmpdir(), `agentdeck-roots-missing-${process.pid}`);
    const input: ProtectedRootsInput = { repo: missing, ownCopy: missing };
    const before = await snapshotProtectedRoots(input);
    expect(before).toMatchObject({ unknown: expect.stringMatching(/worktree list/) });
    const got = await protectedRootsAtStepEnd(task, before, input);
    expect(got).toMatchObject({ unknown: expect.stringMatching(/^before: /) });
    const signal = readJournalLines(task.dir, task.taskId).lines.find(
      (l) => l.kind === 'signal',
    ) as JournalLine<'signal'> | undefined;
    expect(signal?.data).toMatchObject({ signal: 'protected-root-unread', severity: 'warn' });
    task.close();
  });
  it('a layer walk past its ceiling is unknown, not a partial "clean" list', async () => {
    const f = fixture();
    for (let i = 0; i < 5; i += 1) writeFileSync(join(f.skills, `s${i}.md`), 'x');
    expect(await snapshotProtectedRoots({ ...f.input, maxEntries: 3 })).toEqual({
      unknown: 'config dirs: more than 3 entries',
    });
  });
});
