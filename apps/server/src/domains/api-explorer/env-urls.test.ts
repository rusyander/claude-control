import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEnvUrls } from './env-urls.ts';

/** Настоящие файлы во временном каталоге: какие адреса отдаются и какие значения — никогда. */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'env-urls-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, text: string): void => {
  const file = join(root, rel);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

describe('findEnvUrls', () => {
  it('адреса стендов из .env корня и вложенных каталогов, с файлом и ключом', () => {
    write('.env', 'API_URL=http://localhost:8080/\nPORT=8080\n');
    write(
      'e2e/.env',
      '# стенд\nexport DEV_API_URL="https://api.dev.example.com"\nAPP=\'https://app.dev.example.com/v1\' # ui\n',
    );
    expect(findEnvUrls(root)).toEqual([
      { url: 'http://localhost:8080', file: '.env', key: 'API_URL' },
      { url: 'https://api.dev.example.com', file: 'e2e/.env', key: 'DEV_API_URL' },
      { url: 'https://app.dev.example.com/v1', file: 'e2e/.env', key: 'APP' },
    ]);
  });

  it('секретные ключи, вход и колбэки, адрес с паролем, подстановка и не-http — не отдаются', () => {
    write(
      '.env.local',
      [
        'API_TOKEN=https://token.example.com',
        'DB_PASSWORD=https://pass.example.com',
        'WEBHOOK=https://user:hunter2@hook.example.com',
        'CALLBACK=${BASE}/cb',
        'DB=postgres://db:5432/app',
        'PLAIN=hello',
        'APP_LOGIN_URL=http://localhost:3000/login',
        'OAUTH_CALLBACK=https://app.example.com/cb',
      ].join('\n'),
    );
    expect(findEnvUrls(root)).toEqual([]);
  });

  it('повтор адреса — один раз; зависимости и глубже двух уровней — мимо', () => {
    write('.env', 'A=https://x.example.com\n');
    write('.env.example', 'B=https://x.example.com/\n');
    write('node_modules/pkg/.env', 'C=https://dep.example.com\n');
    write('a/b/c/.env', 'D=https://deep.example.com\n');
    expect(findEnvUrls(root).map((item) => item.url)).toEqual(['https://x.example.com']);
  });
});

describe('findEnvUrls в копии задачи', () => {
  it('своего .env нет — адреса основной копии с пометкой main; свои — первыми', () => {
    const main = join(root, 'repo');
    const copy = join(root, 'copies', 'task-1');
    write(
      'repo/e2e/.env',
      'DEV_API_URL=https://api.dev.example.com\nLOCAL=http://localhost:3000\n',
    );
    write('repo/.git/worktrees/task-1/commondir', '../..\n');
    write('copies/task-1/.git', `gitdir: ${join(main, '.git', 'worktrees', 'task-1')}\n`);
    write('copies/task-1/.env', 'LOCAL=http://localhost:3000\n');
    expect(findEnvUrls(copy)).toEqual([
      { url: 'http://localhost:3000', file: '.env', key: 'LOCAL' },
      { url: 'https://api.dev.example.com', file: 'e2e/.env', key: 'DEV_API_URL', main: true },
    ]);
  });
});
