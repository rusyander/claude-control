import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitBashNextTo } from './git-bash.ts';

/** Раскладка Git для Windows: оболочка — `<корень>/bin/bash.exe` от `cmd/`, `bin/` и `mingw64/bin/`. */

const root = mkdtempSync(join(tmpdir(), 'core-git-bash-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const touch = (path: string): string => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
  return path;
};

describe('platform gitBashNextTo', () => {
  it('finds bin/bash.exe from git in cmd/, bin/ and mingw64/bin/; none → null', () => {
    const git = join(root, 'Git');
    const bash = touch(join(git, 'bin', 'bash.exe'));
    expect(gitBashNextTo(join(git, 'cmd', 'git.exe'))).toBe(bash);
    expect(gitBashNextTo(join(git, 'bin', 'git.exe'))).toBe(bash);
    expect(gitBashNextTo(join(git, 'mingw64', 'bin', 'git.exe'))).toBe(bash);
    expect(gitBashNextTo(join(root, 'Other', 'cmd', 'git.exe'))).toBeNull();
  });
});
