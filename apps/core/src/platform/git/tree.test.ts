import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { treeRows } from './tree.ts';

/**
 * Дерево рабочей копии для ключа (D§3.3) на настоящем git: флаги индекса `assume-unchanged` и
 * `skip-worktree` в затравке-копии не прячут правку (B1-F04) — иначе правка такого файла не
 * двигала ключ, и решение повторяло старый зелёный. Разреженная копия (файла на диске нет) — не
 * удаление: строка остаётся, как в индексе.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots)
    rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adk-tree-'));
  roots.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(dir, name), `${name} v1\n`);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base');
  return dir;
}

async function blobs(dir: string): Promise<Record<string, string>> {
  const rows = await treeRows(dir, 'worktree');
  if (!('value' in rows)) throw new Error(JSON.stringify(rows));
  return Object.fromEntries(rows.value.map((r) => [r.path, r.blob]));
}

const blobOf = (dir: string, text: string): string => {
  const file = join(dir, '.probe');
  writeFileSync(file, text);
  const id = git(dir, 'hash-object', file).trim();
  unlinkSync(file);
  return id;
};

describe('worktree tree ignores index flags that hide edits (B1-F04)', () => {
  it('an edit under assume-unchanged or skip-worktree moves the row; the real index keeps its flags', async () => {
    const dir = repo();
    const before = await blobs(dir);
    git(dir, 'update-index', '--assume-unchanged', 'a.txt');
    git(dir, 'update-index', '--skip-worktree', 'b.txt');
    writeFileSync(join(dir, 'a.txt'), 'a.txt v2\n');
    writeFileSync(join(dir, 'b.txt'), 'b.txt v2\n');
    const after = await blobs(dir);
    expect(after['a.txt']).toBe(blobOf(dir, 'a.txt v2\n'));
    expect(after['b.txt']).toBe(blobOf(dir, 'b.txt v2\n'));
    expect(after['c.txt']).toBe(before['c.txt']);
    // Настоящий индекс человека не тронут: флаги на месте.
    const tags = git(dir, 'ls-files', '-v', 'a.txt', 'b.txt');
    expect(tags).toMatch(/^h a\.txt$/m);
    expect(tags).toMatch(/^S b\.txt$/m);
  });

  it('a sparse (skip-worktree) file missing on disk is not a deletion: its row stays as indexed', async () => {
    const dir = repo();
    const before = await blobs(dir);
    git(dir, 'update-index', '--skip-worktree', 'c.txt');
    unlinkSync(join(dir, 'c.txt'));
    const after = await blobs(dir);
    expect(after['c.txt']).toBe(before['c.txt']);
  });
});

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const second = (ms: number): number => Math.floor(ms / 1000);

describe('worktree tree reads a racily clean file by its content', () => {
  it('a same-size rewrite in the second the index was written moves the row, read a second later', async () => {
    // Гонка git: строка индекса совпадает со stat файла, переписанного в ту же секунду тем же
    // размером. Отличить её git может только по mtime индекса — копия затравки обязана его держать.
    // Подготовка повторяется, пока запись, коммит и переписывание не легли в одну секунду.
    let dir = '';
    for (let attempt = 0; attempt < 5 && dir === ''; attempt++) {
      while (Date.now() % 1000 > 100) pause(5);
      const at = Date.now();
      const d = repo();
      writeFileSync(join(d, 'a.txt'), 'a.txt v9\n');
      const st = statSync(join(d, 'a.txt'));
      if (second(st.mtimeMs) === second(at) && second(st.ctimeMs) === second(at)) dir = d;
    }
    expect(dir, 'setup never fit one second').not.toBe('');
    pause(1100);
    expect((await blobs(dir))['a.txt']).toBe(blobOf(dir, 'a.txt v9\n'));
  });
});
