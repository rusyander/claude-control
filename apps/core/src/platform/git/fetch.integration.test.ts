import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinBase } from './fetch.ts';
import { readChangedFiles, readHistory, readTrackedFiles } from './history.ts';

/**
 * База при оценке (G5, F-169) и история для деления — на настоящих репозиториях во временном
 * каталоге: «удалённый» — голый репозиторий рядом, fetch идёт из клона.
 */

let root: string;
const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

function commit(dir: string, file: string, text: string): string {
  writeFileSync(join(dir, file), text);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', file);
  return g(dir, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-fetch-base-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function remoteAndClone(name: string): { bare: string; clone: string; pusher: string } {
  const bare = join(root, `${name}.git`);
  g(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const pusher = join(root, `${name}-pusher`);
  g(root, 'clone', '-q', bare, pusher);
  g(pusher, 'checkout', '-q', '-b', 'main');
  commit(pusher, 'a.txt', 'one');
  g(pusher, 'push', '-q', 'origin', 'main');
  const clone = join(root, `${name}-clone`);
  g(root, 'clone', '-q', bare, clone);
  return { bare, clone, pusher };
}

describe('pin base at estimate', () => {
  it('fetches the remote first: a commit pushed after the clone is the pinned base, source fresh', async () => {
    const { clone, pusher } = remoteAndClone('fresh');
    const newer = commit(pusher, 'b.txt', 'two');
    g(pusher, 'push', '-q', 'origin', 'main');
    const pin = await pinBase(clone, null);
    expect(pin).toEqual({ value: { ref: 'origin/main', sha: newer, source: 'fresh', note: null } });
  });

  it('fetch that fails pins the local ref and names it; no remote pins local main', async () => {
    const { clone } = remoteAndClone('broken');
    const local = g(clone, 'rev-parse', 'origin/main');
    g(clone, 'remote', 'set-url', 'origin', join(root, 'nowhere.git'));
    const pin = await pinBase(clone, null);
    expect('value' in pin && pin.value.sha).toBe(local);
    expect('value' in pin && pin.value.source).toBe('local');
    expect('value' in pin && pin.value.note).toMatch(/^fetch origin failed .*local ref pinned$/);

    const solo = join(root, 'solo');
    g(root, 'init', '-q', '-b', 'main', solo);
    const head = commit(solo, 'x.txt', 'x');
    expect(await pinBase(solo, null)).toEqual({
      value: { ref: 'main', sha: head, source: 'local', note: 'no remote: local ref pinned' },
    });
    // Названная человеком ссылка, которой нет, — `absent`, не тихая подмена основной ветки.
    expect(await pinBase(solo, 'no-such-branch')).toEqual({ absent: true });
  });

  it('history lists files per commit, tracked files and the unit diff incl. untracked', async () => {
    const dir = join(root, 'hist');
    g(root, 'init', '-q', '-b', 'main', dir);
    const base = commit(dir, 'a.txt', '1');
    commit(dir, 'b.txt', '2');
    const hist = await readHistory(dir, 'HEAD');
    expect('value' in hist && hist.value.map((c) => c.files)).toEqual([['b.txt'], ['a.txt']]);
    expect(await readTrackedFiles(dir, 'HEAD')).toEqual({ value: ['a.txt', 'b.txt'] });
    writeFileSync(join(dir, 'new.txt'), 'n');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    const changed = await readChangedFiles(dir, base);
    expect('value' in changed && [...changed.value].sort()).toEqual(['a.txt', 'b.txt', 'new.txt']);
    // Не репозиторий — `unknown`, никогда «ничего не менялось».
    expect('unknown' in (await readChangedFiles(join(root, 'none'), base))).toBe(true);
  });
});
