import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitWorktree, rebaseOnto, revParse, rewriteChain, unitCommits } from './commit-shape.ts';
import { gitVersionOf, mergeTree, parseMergeTree, versionAtLeast } from './merge-tree.ts';
import { deleteRemoteRef, parsePush, pushArgs, pushBranch, type PushRoute } from './push.ts';

/**
 * Git публикатора на настоящих репозиториях во временном каталоге (голый «сервер» + клон):
 * merge-tree без рабочего дерева, переписывание цепочки тем же деревом, пуш с арендой до MR и
 * только перемоткой после, удаление ровно названной ссылки. Настоящий удалённый не трогается.
 */

let root: string;
let bare: string;
let clone: string;
let base: string;
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t' };
const opts = {
  env: { ...env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
};
const route = (): PushRoute => ({ url: bare, gitArgs: [], env: {}, dropEnv: [] });

function write(file: string, text: string, msg: string): string {
  writeFileSync(join(clone, file), text);
  g(clone, 'add', '-A');
  g(clone, 'commit', '-q', '-m', msg);
  return g(clone, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-publish-git-'));
  bare = join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  clone = join(root, 'clone');
  g(root, 'clone', '-q', bare, clone);
  g(clone, 'checkout', '-q', '-b', 'main');
  base = write('a.txt', 'one\n', 'base');
  g(clone, 'push', '-q', 'origin', 'main');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('publisher git', () => {
  it('merge-tree: a clean merge and a conflict naming the file, without touching the worktree', async () => {
    g(clone, 'checkout', '-q', '-b', 'mt-a', base);
    const a = write('a.txt', 'left\n', 'left');
    g(clone, 'checkout', '-q', '-b', 'mt-b', base);
    const b = write('a.txt', 'right\n', 'right');
    g(clone, 'checkout', '-q', '-b', 'mt-c', base);
    const c = write('c.txt', 'c\n', 'other file');
    expect(await mergeTree(clone, a, c)).toEqual({
      value: { kind: 'clean', tree: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    expect(await mergeTree(clone, a, b)).toEqual({
      value: { kind: 'conflict', tree: expect.any(String), files: ['a.txt'] },
    });
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('merge-tree garbage and an odd exit code are errors, never a verdict', () => {
    expect(() => parseMergeTree(0, 'nope')).toThrow(/garbage/);
    expect(() => parseMergeTree(128, `${'a'.repeat(40)}\n`)).toThrow(/exit 128/);
  });

  it('git version gate: 2.38.0 needed for merge-tree --write-tree', () => {
    expect(gitVersionOf('git version 2.55.0.windows.3')).toEqual([2, 55, 0]);
    expect(gitVersionOf('nonsense')).toBeNull();
    expect(versionAtLeast([2, 38, 0], '2.38.0')).toBe(true);
    expect(versionAtLeast([2, 37, 9], '2.38.0')).toBe(false);
    expect(versionAtLeast([3, 0, 0], '2.38.0')).toBe(true);
  });

  it('commitWorktree commits the dirty tree once; a clean tree commits nothing', async () => {
    g(clone, 'checkout', '-q', '-b', 'cw', base);
    writeFileSync(join(clone, 'w.txt'), 'w\n');
    const sha = await commitWorktree(clone, 'feat: worktree', opts);
    expect(sha).toBe(g(clone, 'rev-parse', 'HEAD'));
    expect(await commitWorktree(clone, 'again', opts)).toBeNull();
  });

  it('rewriteChain keeps the last tree, moves the branch only from the expected head', async () => {
    g(clone, 'checkout', '-q', '-b', 'rw', base);
    write('r1.txt', '1\n', 'wip one');
    const head = write('r2.txt', '2\n', 'wip two');
    const tree = g(clone, 'rev-parse', 'HEAD^{tree}');
    const commits = await unitCommits(clone, base, 'HEAD');
    expect(commits.map((c) => c.message)).toEqual(['wip one', 'wip two']);
    const next = await rewriteChain(
      clone,
      'rw',
      base,
      head,
      [{ tree, message: 'feat: one' }],
      opts,
    );
    expect(g(clone, 'rev-parse', `${next}^{tree}`)).toBe(tree);
    expect(await revParse(clone, 'rw')).toBe(next);
    expect(g(clone, 'status', '--porcelain')).toBe('');
    // Ветка ушла — та же перестановка с устаревшим ожиданием не затирает.
    await expect(
      rewriteChain(clone, 'rw', base, head, [{ tree, message: 'x' }], opts),
    ).rejects.toThrow();
    expect(await revParse(clone, 'rw')).toBe(next);
  });

  it('rebaseOnto: a stopped rebase is aborted and the branch stays as it was', async () => {
    g(clone, 'checkout', '-q', '-b', 'rb-base', base);
    const moved = write('a.txt', 'server\n', 'server');
    g(clone, 'checkout', '-q', '-b', 'rb', base);
    const mine = write('a.txt', 'mine\n', 'mine');
    const got = await rebaseOnto(clone, moved, opts);
    expect(got).toEqual({ kind: 'stopped', files: ['a.txt'] });
    expect(g(clone, 'rev-parse', 'HEAD')).toBe(mine);
    expect(g(clone, 'status', '--porcelain')).toBe('');
  });

  it('push before the MR leases on the server sha; after the MR a rewrite is rejected', async () => {
    g(clone, 'checkout', '-q', '-b', 'unit', base);
    const first = write('u.txt', '1\n', 'one');
    expect(
      await pushBranch(clone, route(), 'unit', first, { kind: 'lease', expect: null }),
    ).toEqual({ kind: 'pushed' });
    // Ветка уже есть, а ожидание «её нет» — аренда отказывает.
    const second = write('u.txt', '2\n', 'two');
    expect(
      await pushBranch(clone, route(), 'unit', second, { kind: 'lease', expect: null }),
    ).toMatchObject({ kind: 'rejected' });
    // До MR перезапись с точным ожиданием проходит.
    g(clone, 'reset', '-q', '--hard', base);
    const rewritten = write('u.txt', 'r\n', 'rewritten');
    expect(
      await pushBranch(clone, route(), 'unit', rewritten, { kind: 'lease', expect: first }),
    ).toEqual({ kind: 'pushed' });
    // После MR — только перемотка: переписанная история отказана, новый коммит проходит.
    g(clone, 'reset', '-q', '--hard', base);
    const other = write('u.txt', 'o\n', 'other');
    expect(await pushBranch(clone, route(), 'unit', other, { kind: 'fast-forward' })).toMatchObject(
      { kind: 'rejected' },
    );
    g(clone, 'reset', '-q', '--hard', rewritten);
    const ff = write('u.txt', 'f\n', 'forward');
    expect(await pushBranch(clone, route(), 'unit', ff, { kind: 'fast-forward' })).toEqual({
      kind: 'pushed',
    });
    expect(g(bare, 'rev-parse', 'refs/heads/unit')).toBe(ff);
  });

  it('push args: lease names the ref and the expected sha; fast-forward has no force at all', () => {
    const r = route();
    expect(pushArgs(r, 'b', 'S', { kind: 'lease', expect: 'E' })).toContain(
      '--force-with-lease=refs/heads/b:E',
    );
    expect(pushArgs(r, 'b', 'S', { kind: 'lease', expect: null })).toContain(
      '--force-with-lease=refs/heads/b:',
    );
    expect(pushArgs(r, 'b', 'S', { kind: 'fast-forward' }).join(' ')).not.toMatch(/force/);
    expect(parsePush(1, '!\trefs/heads/b\t[rejected] (stale info)\n')).toMatchObject({
      kind: 'rejected',
    });
  });

  it('deleteRemoteRef removes exactly the named ref and leases on its sha', async () => {
    g(clone, 'checkout', '-q', '-b', 'gone', base);
    const sha = write('g.txt', 'g\n', 'gone');
    g(clone, 'push', '-q', bare, 'gone');
    expect(await deleteRemoteRef(clone, route(), 'refs/heads/gone', base)).toMatchObject({
      kind: 'rejected',
    });
    expect(await deleteRemoteRef(clone, route(), 'refs/heads/gone', sha)).toEqual({
      kind: 'pushed',
    });
    expect(g(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/')).not.toMatch(/gone/);
    expect(g(bare, 'rev-parse', 'refs/heads/main')).toBe(base);
  });
});
