import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputsFingerprint } from '../verifier/profile/detect.ts';
import { PROFILE_VIEW_SPEC } from '../verifier/profile/inputs.ts';
import { readRepoView } from './repo-view.ts';

/**
 * Вид репозитория для профиля (04:45-49, 04:102) из копии единицы — рабочего дерева, где `.git`
 * файл: хуки репозитория лежат в общем каталоге git, и вид копии обязан видеть их так же, как вид
 * основной копии, иначе отпечаток входов у двух видов одного репозитория разный и профиль
 * переобнаруживается и переписывается на каждом чередовании.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-repo-view-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('platform/repo-view worktree', () => {
  it('a worktree copy sees the repo’s .git/hooks through the common dir: same inputs fingerprint as the main checkout', async () => {
    const repo = join(root, 'proj');
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        encoding: 'utf8',
      });
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'package.json'), '{"name":"p"}\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'x');
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const copy = join(root, 'copy');
    git('worktree', 'add', '-q', '--detach', copy);

    const main = await readRepoView(repo, PROFILE_VIEW_SPEC);
    const view = await readRepoView(copy, PROFILE_VIEW_SPEC);
    if (!('value' in main) || !('value' in view)) throw new Error('view unread');
    expect(view.value.files.map((f) => f.path)).toContain('.git/hooks/pre-commit');
    expect(view.value.files).toEqual(main.value.files);
    expect(inputsFingerprint(view.value)).toBe(inputsFingerprint(main.value));
  });
});
