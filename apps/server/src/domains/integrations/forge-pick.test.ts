import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { forgeTokenForUrl, hostOf, pickForge } from './forge-pick.ts';
import { writeSettings, writeToken } from './store/store.ts';

/**
 * GitLab и GitHub — две интеграции (владелец 10.10.2026). Когда подключены
 * обе, фордж выбирается по ссылке или по origin проекта; ключ одного форджа
 * не должен уехать в другой.
 */

let dir: string;
let store: AppStore;

const GITLAB_KEY = ['gl', 'pick', '01'].join('-');
const GITHUB_KEY = ['gh', 'pick', '02'].join('-');

function connect(kind: 'gitlab' | 'github', baseUrl: string, key: string): void {
  writeSettings(store, kind, { enabled: true, baseUrl, repo: '' });
  writeToken(dir, kind, key);
}

function repoWithOrigin(origin: string): string {
  const root = join(dir, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: root });
  return root;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-forge-pick-'));
  store = new AppStore(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('forge-pick', () => {
  it('хост адреса: https, ssh и мусор', () => {
    expect(hostOf('https://user@GitLab.Acme.local/a/b.git')).toBe('gitlab.acme.local');
    expect(hostOf('git@github.com:acme/panel.git')).toBe('github.com');
    expect(hostOf('не адрес')).toBe('');
  });

  it('ничего не подключено — форджа нет; подключён один — он, без вопросов', () => {
    expect(pickForge(store, dir)).toBeUndefined();
    connect('gitlab', 'https://gitlab.acme.local', GITLAB_KEY);
    expect(pickForge(store, dir, { url: 'https://github.com/a/b/issues/1' })).toMatchObject({
      kind: 'gitlab',
      token: GITLAB_KEY,
    });
  });

  it('подключены оба: ссылка решает, origin проекта — когда ссылки нет', () => {
    connect('gitlab', 'https://gitlab.acme.local', GITLAB_KEY);
    connect('github', '', GITHUB_KEY);
    expect(pickForge(store, dir, { url: 'https://github.com/acme/panel/issues/3' })).toMatchObject({
      kind: 'github',
      token: GITHUB_KEY,
    });
    expect(
      pickForge(store, dir, { url: 'https://gitlab.acme.local/acme/panel/-/issues/3' }),
    ).toMatchObject({ kind: 'gitlab', token: GITLAB_KEY });

    const root = repoWithOrigin('git@gitlab.acme.local:acme/panel.git');
    expect(pickForge(store, dir, { root })?.kind).toBe('gitlab');
  });

  it('ключ для ссылки на MR берётся у форджа этой ссылки', () => {
    connect('gitlab', 'https://gitlab.acme.local', GITLAB_KEY);
    connect('github', '', GITHUB_KEY);
    expect(forgeTokenForUrl(store, dir, 'https://github.com/acme/panel/pull/7')).toBe(GITHUB_KEY);
    expect(
      forgeTokenForUrl(store, dir, 'https://gitlab.acme.local/acme/panel/-/merge_requests/7'),
    ).toBe(GITLAB_KEY);
  });
});
