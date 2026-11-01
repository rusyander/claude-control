import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLOSED_PUSH_URL,
  hookScripts,
  hooksDirOf,
  publisherPushSpec,
  SESSION_MARKER,
} from '../../publisher/closure/index.ts';
import { applyPushClosure, readClosureState, repoHooksPath } from './push-closure.ts';

/**
 * Закрытие пуша на настоящем git (05 §Push closure, G6): основной репозиторий, его копия-worktree и
 * голый «удалённый» во временной папке. Глобальный и системный конфиг человека отрезаны
 * (`GIT_CONFIG_GLOBAL` — пустой файл, `GIT_CONFIG_NOSYSTEM`): тест не читает и не пишет чужой git.
 */

let root: string;
let main: string;
let copy: string;
let bare: string;
let hooksDir: string;
let env: NodeJS.ProcessEnv;

const run = (cwd: string, args: string[], extra: Record<string, string> = {}) =>
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, ...extra },
  });
const g = (cwd: string, ...args: string[]): string => {
  const out = run(cwd, args);
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};
const sessionEnv = { [SESSION_MARKER]: 'unit-1' };
const withoutMarker = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(base).filter(([k]) => k.toUpperCase() !== SESSION_MARKER));
const commitIn = (dir: string, name: string): void => {
  writeFileSync(join(dir, name), name);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', `add ${name}`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'core-closure-'));
  const globalFile = join(root, 'gitconfig');
  writeFileSync(globalFile, '');
  env = { ...withoutMarker(process.env), GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: '1' };
  main = join(root, 'main');
  bare = join(root, 'origin.git');
  copy = join(root, 'copy');
  mkdirSync(main);
  execFileSync('git', ['init', '-q', '--bare', bare], { env });
  g(main, 'init', '-q', '-b', 'main');
  commitIn(main, 'a.txt');
  g(main, 'remote', 'add', 'origin', bare);
  g(main, 'remote', 'add', 'mirror', bare);
  g(main, 'worktree', 'add', '-q', '-b', 'unit', copy);
  hooksDir = hooksDirOf(join(root, 'core-home', 'hooks'), 'task-1', 'unit-1');
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const close = () =>
  applyPushClosure(
    { copyDir: copy, hooksDir, closedUrl: CLOSED_PUSH_URL, scripts: hookScripts() },
    { env },
  );

describe('push closure on a real copy', () => {
  it('closes every remote of the copy only, enabling worktree config once', async () => {
    const first = await close();
    if (!('applied' in first)) throw new Error(JSON.stringify(first));
    expect(first.enabledWorktreeConfig).toBe(true);
    expect(first.applied.pushurls).toEqual({ origin: CLOSED_PUSH_URL, mirror: CLOSED_PUSH_URL });
    expect(first.applied.hooksPath).not.toBe('');
    expect(first.applied.hooksDirFp).toMatch(/^[0-9a-f]{64}$/);
    expect(g(main, 'config', '--get', 'extensions.worktreeConfig')).toBe('true');
    // Основная папка не закрыта: покопийный слой есть только у копии.
    expect(run(main, ['config', '--get', 'remote.origin.pushurl']).status).toBe(1);

    const again = await close();
    if (!('applied' in again)) throw new Error(JSON.stringify(again));
    expect(again.enabledWorktreeConfig).toBe(false);
    expect(again.applied).toEqual(first.applied);
  });

  it('a session push by remote name fails before the network, by URL the pre-push refuses', async () => {
    await close();
    commitIn(copy, 'b.txt');
    const byName = run(copy, ['push', 'origin', 'unit'], sessionEnv);
    expect(byName.status).not.toBe(0);
    expect(byName.stderr).toContain('agentdeck-closed');
    const byUrl = run(copy, ['push', bare, 'unit'], sessionEnv);
    expect(byUrl.status).not.toBe(0);
    expect(byUrl.stderr).toContain('agentdeck: pre-push refused inside a session');
    expect(run(bare, ['rev-parse', '--verify', '--quiet', 'refs/heads/unit']).status).not.toBe(0);
  });

  it("chains to the repository's hooks installed after closure (husky layout)", async () => {
    await close();
    // husky ставит `core.hooksPath=.husky/_` в общий конфиг — уже после создания копии.
    g(main, 'config', 'core.hooksPath', '.husky/_');
    const husky = join(copy, '.husky', '_');
    mkdirSync(husky, { recursive: true });
    writeFileSync(join(husky, 'pre-commit'), '#!/bin/sh\necho ran > "$(pwd)/pre-commit.ran"\n', {
      mode: 0o755,
    });
    writeFileSync(join(husky, 'pre-push'), '#!/bin/sh\necho ran > "$(pwd)/pre-push.ran"\n', {
      mode: 0o755,
    });
    commitIn(copy, 'c.txt');
    expect(existsSync(join(copy, 'pre-commit.ran'))).toBe(true);
    // Без метки сеанса (человек в копии) pre-push ядра пропускает к хуку репозитория.
    const human = run(copy, ['push', bare, 'unit']);
    expect(human.status, human.stderr).toBe(0);
    expect(existsSync(join(copy, 'pre-push.ran'))).toBe(true);
    expect(await repoHooksPath(copy, { env })).toEqual({ value: '.husky/_' });
    g(main, 'config', '--unset', 'core.hooksPath');
  });

  it("the publisher's own push passes with the session marker in its env", async () => {
    await close();
    commitIn(copy, 'd.txt');
    const hooks = await repoHooksPath(copy, { env });
    if (!('value' in hooks)) throw new Error('no hooks path');
    expect(hooks.value.endsWith('hooks')).toBe(true);
    const spec = publisherPushSpec({ url: bare, repoHooksPath: hooks.value, credential: null });
    const base: NodeJS.ProcessEnv = { ...env, ...sessionEnv, ...spec.env };
    for (const name of spec.dropEnv) delete base[name];
    const out = spawnSync('git', [...spec.gitArgs, 'push', spec.url, 'unit'], {
      cwd: copy,
      encoding: 'utf8',
      env: base,
    });
    expect(out.status, out.stderr).toBe(0);
    expect(g(bare, 'rev-parse', 'refs/heads/unit')).toBe(g(copy, 'rev-parse', 'HEAD'));
  });

  it('reads every effective pushurl, so a common one beside the closed value is visible', async () => {
    await close();
    g(main, 'config', '--add', 'remote.origin.pushurl', 'https://example.com/r.git');
    const state = await readClosureState(copy, hooksDir, { env });
    if (!('value' in state)) throw new Error('no state');
    expect(state.value.pushurls.origin!.split('\n').sort()).toEqual(
      [CLOSED_PUSH_URL, 'https://example.com/r.git'].sort(),
    );
    g(main, 'config', '--unset-all', 'remote.origin.pushurl');
  });

  it('refuses a repository whose common config says core.bare=true', async () => {
    const bareMain = join(root, 'bare-main.git');
    execFileSync('git', ['clone', '-q', '--bare', bare, bareMain], { env });
    const bareCopy = join(root, 'bare-copy');
    g(bareMain, 'worktree', 'add', '-q', bareCopy, 'unit');
    const out = await applyPushClosure(
      {
        copyDir: bareCopy,
        hooksDir: join(root, 'h2'),
        closedUrl: CLOSED_PUSH_URL,
        scripts: hookScripts(),
      },
      { env },
    );
    expect(out).toEqual({ refused: expect.stringContaining('core.bare=true') });
    expect(run(bareMain, ['config', '--get', 'extensions.worktreeConfig']).status).toBe(1);
  });
});
