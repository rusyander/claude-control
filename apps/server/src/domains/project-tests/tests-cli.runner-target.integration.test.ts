import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * M3 (g5 27.10): `run --health http://localhost:5173` записал кейсы Playwright
 * «заблокирован» — а наборы шли на `process.env.E2E_BASE_URL ?? 'https://inst.dev…'`:
 * проверялся стенд, которого раннер не касается. Здесь настоящий пакет Playwright
 * (раннер из node_modules репозитория, тесты без браузера) и настоящий HTTP-стенд:
 * `--health` без адреса спрашивает адрес конфига (переменная первой), чужой адрес —
 * отказ с обоими адресами до прогона и до записи.
 */
const REPO = resolve(__dirname, '../../../../..');
const CLI = join(REPO, 'tools/tests-cli.mjs');
const PKG = 'QA/auto/frontend';
const SPEC = `import { test, expect } from 'playwright/test';\ntest('users list', () => { expect(1).toBe(1); });\n`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

describe('tests-cli run --health: стенд — тот, куда ходит раннер', { timeout: 180_000 }, () => {
  let dir = '';
  let server: Server | undefined;
  const cli = (env: Record<string, string>, ...args: string[]) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, [CLI, ...args, '--project', dir], {
        env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '', CI: '1', E2E_BASE_URL: '', ...env },
      });
      let out = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      child.on('close', (code) => done({ code, out }));
    });
  const run = (env: Record<string, string>, ...health: string[]) =>
    cli(env, 'run', '--case', 'qa:qa-001', '--fresh', '--health', ...health);

  /** Порт, который только что был открыт и закрыт, — стенд «лежит». */
  const closedPort = () =>
    new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => done(port));
      });
    });
  const liveStand = async () => {
    server = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const config = (fallback: string) =>
    write(dir, {
      [`${PKG}/playwright.config.mjs`]:
        `const BASE = process.env.E2E_BASE_URL ?? '${fallback}';\n` +
        `export default { testDir: '.', workers: 1, use: { baseURL: BASE } };\n`,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-target-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules/\n');
    write(dir, {
      [`${PKG}/package.json`]: JSON.stringify({
        name: 'frontend',
        private: true,
        type: 'module',
        devDependencies: { playwright: '1.61.1' },
      }),
      [`${PKG}/inst/users/users.spec.mjs`]: SPEC,
    });
    mkdirSync(join(dir, PKG, 'node_modules'));
    symlinkSync(
      join(REPO, 'node_modules', 'playwright'),
      join(dir, PKG, 'node_modules', 'playwright'),
      'junction',
    );
    git(dir, 'add', '.');
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'main');
    createGroup(dir, 'qa', 'qa');
    upsertCase(
      dir,
      'qa',
      {
        title: 'Спек users',
        steps: ['playwright test users.spec.mjs'],
        expected: 'users list проходит',
        codePaths: [`${PKG}/inst/users`],
        automation: {
          status: 'automated',
          file: `${PKG}/inst/users/users.spec.mjs`,
          testName: `${PKG}/inst/users/users.spec.mjs`,
        },
      },
      '2026-10-27T09:00:00.000Z',
    );
  });

  afterEach(async () => {
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('--health без адреса — адрес конфига по умолчанию: стенд жив, прогон идёт, кейс зелёный', async () => {
    const stand = await liveStand();
    config(stand);
    const ran = await run({});
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toContain(`Стенд: ${stand} (E2E_BASE_URL не задан — по умолчанию конфига)`);
    expect(readRuns(dir)[0]?.results[0]?.status).toBe('passed');
  });

  it('--health без адреса — переменная окружения первой: её стенд лежит, кейс «заблокирован» с её адресом', async () => {
    const stand = await liveStand();
    config(stand);
    const down = `http://127.0.0.1:${await closedPort()}`;
    const ran = await run({ E2E_BASE_URL: down });
    expect(ran.code, ran.out).toBe(75);
    expect(ran.out).toContain(`Стенд: ${down} (E2E_BASE_URL)`);
    const [record] = readRuns(dir);
    expect(record?.results[0]?.status).toBe('blocked');
    expect(record?.results[0]?.note).toContain(`Стенд ${down} не отвечает`);
  });

  it('--health с чужим адресом — отказ до прогона, названы оба адреса, истории нет', async () => {
    config('https://inst.dev.example.com');
    const ran = await run({}, 'http://localhost:5173');
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('--health http://localhost:5173 — не тот стенд');
    expect(ran.out).toContain('https://inst.dev.example.com');
    expect(readRuns(dir)).toHaveLength(0);
  });

  it('--health с тем же стендом другим именем хоста (localhost ≡ 127.0.0.1) — принят', async () => {
    const stand = await liveStand();
    config(stand);
    const ran = await run({}, stand.replace('127.0.0.1', 'localhost'));
    expect(ran.code, ran.out).toBe(0);
  });
});
