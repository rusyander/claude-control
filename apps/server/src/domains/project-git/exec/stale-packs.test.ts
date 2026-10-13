import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from './exec.ts';
import { STALE_PACK_AGE_MS, fetchesPack, gitSubcommand, sweepStalePacks } from './stale-packs.ts';

/**
 * Недокачанные пакеты убитого `fetch`: настоящий репозиторий, настоящая копия
 * worktree (её `objects` общие с основным), файлы с подставленным возрастом.
 */

let root: string;

const sh = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });

const packDir = (): string => join(root, 'main', '.git', 'objects', 'pack');

const plant = (name: string, ageMs: number): string => {
  const path = join(packDir(), name);
  writeFileSync(path, 'PACK');
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(path, at, at);
  return path;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-stale-packs-'));
  const main = join(root, 'main');
  sh(root, ['init', '-q', 'main']);
  sh(main, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one',
  ]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gitSubcommand / fetchesPack', () => {
  it('пропускает ключи -c перед подкомандой', () => {
    expect(gitSubcommand(['-c', 'core.longpaths=true', 'fetch', 'origin'])).toBe('fetch');
    expect(fetchesPack(['-c', 'a=b', 'pull', '--ff-only'])).toBe(true);
    expect(fetchesPack(['ls-remote', 'origin'])).toBe(false);
    expect(fetchesPack(['log', '--', 'fetch'])).toBe(false);
  });
});

describe('sweepStalePacks', () => {
  it('убирает старые tmp_* и не трогает свежие, настоящие пакеты и чужие имена', async () => {
    const old = plant('tmp_pack_aB3dEf', STALE_PACK_AGE_MS + 60_000);
    const oldIdx = plant('tmp_idx_Zz9', STALE_PACK_AGE_MS * 3);
    const fresh = plant('tmp_pack_live01', 60_000);
    const real = plant('pack-0123abcd.keep', STALE_PACK_AGE_MS * 5);

    const removed = await sweepStalePacks(join(root, 'main'));

    expect(removed.sort()).toEqual(['tmp_idx_Zz9', 'tmp_pack_aB3dEf']);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldIdx)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(real)).toBe(true);
  });

  it('из копии worktree метёт общий objects основного репозитория', async () => {
    const copy = join(root, 'copy');
    sh(join(root, 'main'), ['worktree', 'add', '-q', '-b', 'side', copy]);
    const old = plant('tmp_pack_fromCopy', STALE_PACK_AGE_MS * 2);

    expect(await sweepStalePacks(copy)).toEqual(['tmp_pack_fromCopy']);
    expect(existsSync(old)).toBe(false);
  });

  it('не репозиторий — пустой ответ, не исключение', async () => {
    expect(await sweepStalePacks(root)).toEqual([]);
  });

  it('git() перед fetch убирает брошенный пакет, перед другими командами — нет', async () => {
    const main = join(root, 'main');
    const bare = join(root, 'origin.git');
    sh(root, ['clone', '-q', '--bare', main, bare]);
    sh(main, ['remote', 'add', 'origin', bare]);

    const beforeStatus = plant('tmp_pack_status', STALE_PACK_AGE_MS * 2);
    await git(main, ['status', '--porcelain']);
    expect(existsSync(beforeStatus)).toBe(true);

    await git(main, ['fetch', '--quiet', 'origin']);
    expect(existsSync(beforeStatus)).toBe(false);
    expect(readdirSync(packDir()).filter((name) => name.startsWith('tmp_'))).toEqual([]);
  });
});
