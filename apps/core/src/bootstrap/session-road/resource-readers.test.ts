import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insideGitRepo, REAL_READERS } from './resource-readers.ts';

// Настоящий git и настоящий временный каталог: вопрос именно в том, что отвечает git вне репозитория.
const made: string[] = [];
function tempDir(): string {
  // `.native` раскрывает короткое имя 8.3 (RUSYAN~1), git отвечает длинным.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ad-readers-')));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session resource readers: worktrees of a session cwd', () => {
  it('a cwd outside any repository has no worktrees — an empty list, not an unread scan', async () => {
    const dir = tempDir();
    expect(insideGitRepo(dir)).toBe(false);
    expect(await REAL_READERS.worktrees(dir)).toEqual({ value: [] });
  });

  it('a cwd nested inside a repository is read through git and lists the main checkout', async () => {
    const repo = tempDir();
    execFileSync('git', ['init', '-q', repo]);
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(insideGitRepo(nested)).toBe(true);
    const got = await REAL_READERS.worktrees(nested);
    if (!('value' in got)) throw new Error(`unread: ${JSON.stringify(got)}`);
    expect(got.value.map((t) => t.path.replace(/\\/g, '/').toLowerCase())).toContain(
      repo.replace(/\\/g, '/').toLowerCase(),
    );
  });
});
