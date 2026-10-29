import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  LOCK,
  copyPathOf,
  decisions,
  git,
  installer,
  makeRepo,
  taskWithUnit,
  wiring,
} from './__fixtures__/copy-harness.ts';
import { createUnitCopy } from './create.ts';

/**
 * Повтор и восстановление копии единицы по настоящему пути (04:97-99, G7): чужой каталог на месте
 * копии не удаляется, своя недовыложенная копия после краха снимается и выкладывается заново,
 * база закреплена первой попыткой, хвост провала несёт причину git, откат lock-файлов видит
 * любую глубину и не путает переписанное прошлой установкой с легитимной грязью.
 */

describe('unit copy recovery', () => {
  it('a foreign dir whose .git points nowhere is refused and named, never removed', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const target = copyPathOf(root, branch);
    mkdirSync(target, { recursive: true });
    const gone = join(tempDir('old-'), 'proj', '.git', 'worktrees', 'feature');
    writeFileSync(join(target, '.git'), `gitdir: ${gone}\n`);
    writeFileSync(join(target, 'mine.txt'), 'human work\n');
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    expect(got.value.decision.verdict).toBe('failed');
    expect(got.value.decision.failure?.tail).toContain('foreign-copy');
    expect(got.value.decision.failure?.tail).toContain(target);
    expect(readFileSync(join(target, 'mine.txt'), 'utf8')).toBe('human work\n');
    task.close();
  });

  it('own copy left locked «initializing» by a crash mid checkout is released and placed again', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const dir = copyPathOf(root, branch);
    // Прошлая попытка ядра: действие начато (fsync до эффекта), git убит посреди выкладки.
    task.append({
      kind: 'action.started',
      actor: 'core',
      unitId,
      data: {
        actionId: newId(),
        kind: 'copy-create',
        target: dir,
        idempotencyHint: `${branch}@${base}`,
      },
    });
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir, base);
    writeFileSync(join(git(dir, 'rev-parse', '--absolute-git-dir'), 'locked'), 'initializing\n');
    rmSync(join(dir, 'package.json'));
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    expect(got.value.decision.failure).toBeUndefined();
    const placed = got.value.placed;
    if (!placed) throw new Error('no copy placed');
    expect(readFileSync(join(placed.dir, 'package.json'), 'utf8')).toBe('{"name":"p"}\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('locked');
    task.close();
  });

  it('a journaled create failure is not reused: the next prepare after the cause is gone sets the copy up', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const target = copyPathOf(root, branch);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'mine.txt'), 'human file\n');
    const w = wiring(task, root, installer().install);
    const first = await w.prepare(task.taskId, unitId);
    if (!('value' in first)) throw new Error('prepare unread');
    expect(first.value.decision.failure?.stage).toBe('create');
    // Тот же сбой хвостом шага: путь каталога и причина, а не голый код.
    expect(first.value.decision.failure?.tail).toContain('exists and is not a worktree');
    rmSync(target, { recursive: true });
    const again = await w.prepare(task.taskId, unitId);
    if (!('value' in again)) throw new Error('prepare unread');
    expect(again.value.journaled).toBe(true);
    expect(again.value.decision.verdict).toBe('ready-with-gaps');
    expect(again.value.placed).toBeDefined();
    task.close();
  });

  it('create failure carries git’s fatal line in the tail, not the bare action code', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId, branch } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    git(repo, 'worktree', 'add', '-q', '-b', branch, join(root, 'elsewhere'), base);
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got)) throw new Error('prepare unread');
    const failure = got.value.decision.failure;
    expect(failure?.stage).toBe('create');
    expect(failure?.tail).toMatch(/^copy-create worktree-add: .*fatal: /s);
    // Текст отказа у git разный по версиям: 2.4x+ «already used by worktree», старее «already checked out at».
    expect(failure?.firstError).toMatch(/^fatal: .*already (used by worktree|checked out at)/);
    task.close();
  });

  it('lock files rewritten by install below the first level are reverted too', async () => {
    const { repo, base } = makeRepo({
      'services/api/go.mod': 'module x\n',
      'services/api/go.sum': 'h1\n',
    });
    const { task, unitId } = await taskWithUnit(repo, base);
    const inst = installer({}, ['services/api/go.sum']);
    const got = await wiring(task, tempDir('cpw-'), inst.install).prepare(task.taskId, unitId);
    if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
    const dir = got.value.placed.dir;
    expect(readFileSync(join(dir, 'services', 'api', 'go.sum'), 'utf8')).toBe('h1\n');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    task.close();
  });

  it('resume after a crash mid setup reverts the lock file the crashed install rewrote', async () => {
    const { repo, base } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, base);
    const root = tempDir('cpw-');
    const created = await createUnitCopy(task, unitId, { root: join(root, 'copies') });
    if (!created.ok) throw new Error(created.failed);
    // Первая установка переписала lock-файл, ядро упало до решения `copy-setup`.
    writeFileSync(join(created.placed.dir, 'pnpm-lock.yaml'), `${LOCK}# crashed install\n`);
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
    expect(readFileSync(join(got.value.placed.dir, 'pnpm-lock.yaml'), 'utf8')).toBe(LOCK);
    expect(git(got.value.placed.dir, 'status', '--porcelain')).toBe('');
    expect(decisions(task).filter((d) => d.class === 'copy-setup')).toHaveLength(1);
    task.close();
  });

  it('the base is pinned by the first attempt: a moved base ref after a crash changes neither the copy nor baseSha', async () => {
    const { repo, head } = makeRepo();
    const { task, unitId } = await taskWithUnit(repo, 'main');
    const root = tempDir('cpw-');
    const created = await createUnitCopy(task, unitId, { root: join(root, 'copies') });
    if (!created.ok) throw new Error(created.failed);
    expect(created.placed.baseSha).toBe(head);
    writeFileSync(join(repo, 'moved.txt'), 'C\n');
    git(repo, 'add', 'moved.txt');
    git(repo, 'commit', '-q', '-m', 'C');
    const got = await wiring(task, root, installer().install).prepare(task.taskId, unitId);
    if (!('value' in got) || !got.value.placed) throw new Error('prepare unread');
    expect(got.value.placed.baseSha).toBe(head);
    expect(got.value.placed.head).toBe(head);
    expect(existsSync(join(got.value.placed.dir, 'moved.txt'))).toBe(false);
    task.close();
  });
});
