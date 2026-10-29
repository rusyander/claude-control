import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDetachedWorktree,
  commonDir,
  commonDirSync,
  createOnceLinked,
  inputDigests,
  listStoreDir,
  parseLsTree,
  scratchIndexTree,
  treeRows,
  type GitRunner,
  type TreeRow,
} from './git.ts';
import { currentOs } from './os-kind.ts';
import { samePath } from './paths.ts';
import { runTool } from './run-tool.ts';

/**
 * platform/git на настоящем git во временных репозиториях (P51: различия ОС — здесь). Свойства
 * ключа (04:10, D§3.3): одна форма строк у коммита и рабочей копии, режим файла в строке.
 */

let root: string;
const isWin = currentOs() === 'win32';

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const run = await runTool('git', ['-C', cwd, ...args], { timeoutMs: 30_000 });
  if (!run.ok) throw new Error(`git ${args.join(' ')}: ${run.reason} ${run.stderr ?? ''}`);
  return run.stdout.trim();
}

async function newRepo(name: string): Promise<string> {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await sh(repo, 'init', '-q', '-b', 'main');
  await sh(repo, 'config', 'user.email', 't@example.com');
  await sh(repo, 'config', 'user.name', 't');
  await sh(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  mkdirSync(join(repo, 'pkg'));
  writeFileSync(join(repo, 'pkg', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
  await sh(repo, 'add', '-A');
  await sh(repo, 'commit', '-q', '-m', 'one');
  return repo;
}

function rowsOf(fact: Awaited<ReturnType<typeof treeRows>>): TreeRow[] {
  if (!('value' in fact)) throw new Error(`no rows: ${JSON.stringify(fact)}`);
  return fact.value;
}

/**
 * Временные индексы этого чтения — в своём temp на время вызова. Общий temp прогона делят все
 * рабочие vitest: чужое чтение дерева в соседнем файле создаёт и снимает там свои
 * `agentdeck-index-*`, и счёт по общему каталогу краснел только в параллельном прогоне.
 */
async function withOwnTemp<T>(dir: string, read: () => Promise<T>): Promise<T> {
  const names = ['TEMP', 'TMP', 'TMPDIR'] as const;
  const saved = names.map((n) => process.env[n]);
  mkdirSync(dir, { recursive: true });
  for (const n of names) process.env[n] = dir;
  try {
    return await read();
  } finally {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n];
      else process.env[n] = saved[i];
    });
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-git-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('platform/git tree rows (04:10, D§3.3)', () => {
  it('P07 work tree and commit give the same rows; amend, no-op rebase, checkout -- and another copy keep them', async () => {
    const repo = await newRepo('same');
    const head = rowsOf(await treeRows(repo, 'HEAD'));
    expect(head.map((r) => r.path)).toEqual(['.gitignore', 'a.txt', 'pkg/b.ts']);
    expect(rowsOf(await treeRows(repo, 'worktree'))).toEqual(head);

    await sh(repo, 'commit', '-q', '--amend', '--no-edit', '--allow-empty');
    expect(rowsOf(await treeRows(repo, 'HEAD'))).toEqual(head);
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    await sh(repo, 'add', 'c.txt');
    await sh(repo, 'commit', '-q', '-m', 'two');
    const two = rowsOf(await treeRows(repo, 'HEAD'));
    await sh(repo, 'rebase', '-q', '--force-rebase', 'HEAD~1');
    expect(rowsOf(await treeRows(repo, 'HEAD'))).toEqual(two);

    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    expect(rowsOf(await treeRows(repo, 'worktree'))).not.toEqual(two);
    await sh(repo, 'checkout', '--', 'a.txt');
    expect(rowsOf(await treeRows(repo, 'worktree'))).toEqual(two);

    const copy = join(root, 'same-copy');
    const added = await addDetachedWorktree(repo, copy, 'HEAD');
    expect('created' in added).toBe(true);
    expect(rowsOf(await treeRows(copy, 'worktree'))).toEqual(two);
  });

  it('P07 the work tree form takes untracked files, drops ignored ones and leaves the real index alone', async () => {
    const repo = await newRepo('untracked');
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    writeFileSync(join(repo, 'new.txt'), 'n\n');
    mkdirSync(join(repo, 'ignored'));
    writeFileSync(join(repo, 'ignored', 'x.txt'), 'x\n');
    rmSync(join(repo, 'pkg', 'b.ts'));
    const temp = join(root, 'untracked-temp');
    const rows = rowsOf(await withOwnTemp(temp, () => treeRows(repo, 'worktree')));
    expect(rows.map((r) => r.path)).toEqual(['.gitignore', 'a.txt', 'new.txt']);
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(indexBefore);
    expect(await sh(repo, 'status', '--porcelain')).toContain('?? new.txt');
    // P40: временный индекс снят в том же чтении — в своём temp не осталось ничего.
    expect(readdirSync(temp)).toEqual([]);
    const tree = await scratchIndexTree(repo);
    expect('value' in tree && /^[0-9a-f]{40}$/.test(tree.value)).toBe(true);
  });

  it('P07 a file mode change (chmod +x) changes the rows of both forms', async () => {
    const repo = await newRepo('mode');
    const plain = rowsOf(await treeRows(repo, 'worktree'));
    // Windows (core.fileMode=false) держит режим в индексе; POSIX — на диске.
    if (isWin) await sh(repo, 'update-index', '--chmod=+x', 'a.txt');
    else chmodSync(join(repo, 'a.txt'), 0o755);
    const exec = rowsOf(await treeRows(repo, 'worktree'));
    expect(exec.find((r) => r.path === 'a.txt')?.mode).toBe('100755');
    expect(plain.find((r) => r.path === 'a.txt')?.mode).toBe('100644');
    expect(exec.find((r) => r.path === 'a.txt')?.blob).toBe(
      plain.find((r) => r.path === 'a.txt')?.blob,
    );
    await sh(repo, 'add', '-A');
    await sh(repo, 'commit', '-q', '-m', 'exec');
    expect(rowsOf(await treeRows(repo, 'HEAD'))).toEqual(exec);
  });

  it('a revision that does not exist is absent (read: git said no), never unknown', async () => {
    const repo = await newRepo('norev');
    expect(await treeRows(repo, 'refs/heads/nope')).toEqual({ absent: true });
  });

  it('P44 git.tree fault: timeout, ENOENT, EPERM and garbage output → unknown, never absent', async () => {
    const repo = await newRepo('faults');
    const failing = (reason: string, timedOut = false): GitRunner =>
      (async () => ({ ok: false, reason, timedOut })) as GitRunner;
    const garbage: GitRunner = (async (_file: string, args: readonly string[]) => {
      if (args.includes('rev-parse'))
        return { ok: true, code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '', timedOut: false };
      return { ok: true, code: 0, stdout: '100644 blob nothex\tx\0', stderr: '', timedOut: false };
    }) as GitRunner;
    const runs: Record<string, GitRunner> = {
      timeout: failing('timeout after 30000 ms', true),
      ENOENT: failing('ENOENT: spawn git'),
      EPERM: failing('EPERM: operation not permitted'),
      garbage,
    };
    for (const [fault, run] of Object.entries(runs)) {
      for (const rev of ['HEAD', 'worktree']) {
        const fact = await treeRows(repo, rev, { run });
        expect({ fault, rev, kind: 'unknown' in fact ? 'unknown' : 'other' }).toEqual({
          fault,
          rev,
          kind: 'unknown',
        });
      }
      const common = await commonDir(repo, { run: run === garbage ? failing('x') : run });
      expect('unknown' in common).toBe(true);
    }
    expect(() => parseLsTree('040000 tree ' + 'a'.repeat(40) + '\tdir\0')).toThrow(/garbage/);
  });
});

describe('platform/git common dir, copies, inputs, store files', () => {
  it('common dir: the main checkout and its worktree copy name the same dir, sync and async agree', async () => {
    const repo = await newRepo('common');
    const copy = join(root, 'common-copy');
    expect('created' in (await addDetachedWorktree(repo, copy, 'HEAD'))).toBe(true);
    const main = await commonDir(repo);
    const other = await commonDir(copy);
    expect('value' in main && 'value' in other).toBe(true);
    if (!('value' in main) || !('value' in other)) return;
    expect(samePath(main.value, other.value)).toBe(true);
    const syncMain = commonDirSync(repo);
    const syncCopy = commonDirSync(copy);
    expect('value' in syncMain && samePath(syncMain.value, main.value)).toBe(true);
    expect('value' in syncCopy && samePath(syncCopy.value, main.value)).toBe(true);
    expect(commonDirSync(join(root, 'not-a-repo'))).toEqual({ absent: true });
  });

  it('a detached base copy runs no project hook and is at the asked revision', async () => {
    const repo = await newRepo('hooks');
    const marker = join(root, 'hook-ran');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'hooks', 'post-checkout'),
      `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\n`,
      { mode: 0o755 },
    );
    const head = await sh(repo, 'rev-parse', 'HEAD');
    const added = await addDetachedWorktree(repo, join(root, 'hooks-copy'), head);
    expect(added).toEqual({ created: join(root, 'hooks-copy'), head });
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(root, 'hooks-copy', 'work.txt'), 'uncommitted');
    const again = await addDetachedWorktree(repo, join(root, 'hooks-copy'), head);
    expect('failed' in again).toBe(true);
    // Уборка после неудачного add снимает только то, что этот вызов выложил, — не прежнюю копию.
    expect(readFileSync(join(root, 'hooks-copy', 'work.txt'), 'utf8')).toBe('uncommitted');
    expect(await sh(repo, 'worktree', 'list')).toContain('hooks-copy');
  });

  it('a detached copy whose git was killed mid checkout (lock «initializing» left) is undone, C locale on add', async () => {
    const repo = await newRepo('killed-detached');
    const envs: NodeJS.ProcessEnv[] = [];
    // Внешняя граница — процесс git: выкладка прошла, замок остался, ядро видит таймаут.
    const run: GitRunner = async (file, args, options) => {
      if (!(args.includes('worktree') && args.includes('add'))) return runTool(file, args, options);
      envs.push(options?.env ?? {});
      await runTool(file, args, options);
      writeFileSync(join(repo, '.git', 'worktrees', 'killed-dcopy', 'locked'), 'initializing\n');
      return { ok: false, reason: 'timed out after 120000 ms', timedOut: true };
    };
    const dir = join(root, 'killed-dcopy');
    const got = await addDetachedWorktree(repo, dir, 'HEAD', { run });
    expect(got).toMatchObject({ failed: expect.stringContaining('timed out') });
    expect(existsSync(dir)).toBe(false);
    expect(await sh(repo, 'worktree', 'list')).not.toContain('killed-dcopy');
    expect(envs[0]).toMatchObject({ LC_ALL: 'C', LANGUAGE: 'C' });
  });

  it('inputs outside git: absence is a value, a change moves the digest', async () => {
    const top = join(root, 'inputs');
    mkdirSync(join(top, 'cfg'), { recursive: true });
    const first = await inputDigests(top, ['.env*', 'cfg', 'missing.lock']);
    expect(first).toEqual({
      value: { cfg: expect.stringMatching(/^dir:/), 'missing.lock': 'absent' },
    });
    writeFileSync(join(top, '.env.local'), 'A=1\n');
    const second = await inputDigests(top, ['.env*', 'cfg', 'missing.lock']);
    expect('value' in second && second.value['.env.local']).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(top, 'cfg', 'x.json'), '{}');
    const third = await inputDigests(top, ['.env*', 'cfg', 'missing.lock']);
    expect('value' in second && 'value' in third && second.value.cfg !== third.value.cfg).toBe(
      true,
    );
  });

  it('write-once store file: the second create of a name is refused and the first content stays', () => {
    const file = join(root, 'store', 'ab', 'x.json');
    expect(listStoreDir(join(root, 'store', 'ab'))).toEqual({ absent: true });
    expect(createOnceLinked(file, Buffer.from('first'))).toBe('created');
    expect(createOnceLinked(file, Buffer.from('second'))).toBe('exists');
    expect(readFileSync(file, 'utf8')).toBe('first');
    expect(listStoreDir(join(root, 'store', 'ab'))).toEqual({ value: ['x.json'] });
  });
});
