import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MutationChecks } from './mutation.ts';
import { createE2eFolder } from './e2e-folder.ts';
import { syncE2eFolder } from './e2e-sync.ts';
import { readGroups, writeGroup } from './store.ts';
import { saveEnvironment } from './library.ts';
import { installFakeRunners, markRunnerInstalled } from './__fixtures__/fake-runners.ts';

/**
 * Ветка e2e проверки поломкой и стенд (Ф8). Автотесты e2e ходят в стенд: без
 * его адреса или доступов падают все, и проверка читала каждое падение как
 * «поломка поймана». Теперь без стенда — «не проверено: нет стенда», со стендом
 * — адрес и доступы доходят до раннера, а значения доступов в вывод не попадают.
 * Подменён только раннер (`npx` на PATH пишет отчёт, как настоящий Playwright).
 */

const SPEC = `import { test } from '@playwright/test';
test.describe('Вход', () => {
  test('[auth-001] вход по паролю', async () => {});
});
`;
const JUNIT_RED =
  '<testsuites><testsuite name="auth.spec.ts">' +
  '<testcase name="Вход › [auth-001] вход по паролю" classname="auth.spec.ts" time="1">' +
  '<failure message="connect ECONNREFUSED"/></testcase></testsuite></testsuites>';
const NOW = '2026-10-05T10:00:00.000Z';
const SECRET = 's3cr3t-token-value';

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
}

describe('проверка поломкой: ветка e2e и стенд (Ф8)', () => {
  let base = '';
  let root = '';
  let appData = '';
  let argvFile = '';
  let fake: ReturnType<typeof installFakeRunners>;
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string): void => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-mutation-stand-')));
    root = join(base, 'repo');
    appData = join(base, 'data');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(appData);
    writeFileSync(join(root, 'src', 'app.mjs'), 'export const ok = true;\n');
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '-m', 'init']);
    // Папка e2e панели (спрятана от git) с установленным раннером и одним тестом.
    createE2eFolder(appData, root, NOW);
    markRunnerInstalled(join(root, 'e2e'), 'playwright');
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, NOW, { dir: 'e2e', appData });
    for (const group of readGroups(root)) {
      writeGroup(root, {
        ...group,
        cases: group.cases.map((item) => ({ ...item, codePaths: ['src/app.mjs'] })),
      });
    }
    fake = installFakeRunners();
    argvFile = join(fake.bin, 'argv.json');
    setEnv('FAKE_E2E_ARGV', argvFile);
    // Раннер «без стенда»: тест красный при любой поломке и без неё.
    setEnv('FAKE_E2E_JUNIT', JUNIT_RED);
  });

  afterEach(() => {
    fake.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(fake.bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const finished = async (checks: MutationChecks) => {
    await vi.waitFor(() => expect(checks.status(root)?.status).not.toBe('running'), {
      timeout: 60_000,
      interval: 100,
    });
    return checks.status(root);
  };

  it('нет адреса стенда — «не проверено: нет стенда», а не «поймали»; раннер не запускался', async () => {
    const checks = new MutationChecks();
    checks.start({ root, appData, file: 'src/app.mjs' });
    const check = await finished(checks);
    expect(check).toMatchObject({ status: 'error', errorCode: 'mutation-no-stand', caught: 0 });
    expect(() => readFileSync(argvFile)).toThrow();
  }, 90_000);

  it('нет значения доступа на машине — «не проверено» с именем переменной', async () => {
    const stand = saveEnvironment(root, { title: 'Стенд', baseUrl: 'https://stand.example.com' });
    const checks = new MutationChecks();
    checks.start({
      root,
      appData,
      file: 'src/app.mjs',
      environmentId: stand.id,
      secrets: () => ({ values: {}, missing: [{ name: 'E2E_SECRET_TOKEN' }] }),
    });
    const check = await finished(checks);
    expect(check).toMatchObject({
      status: 'error',
      errorCode: 'mutation-no-secrets',
      caught: 0,
    });
    expect(check?.params).toEqual({ names: 'E2E_SECRET_TOKEN' });
  }, 90_000);

  it('стенд есть — адрес и доступ доходят до раннера, значение доступа в вывод не попадает', async () => {
    const stand = saveEnvironment(root, { title: 'Стенд', baseUrl: 'https://stand.example.com' });
    setEnv(
      'FAKE_E2E_JUNIT',
      JUNIT_RED.replace('</testsuite>', `<system-out>${SECRET}</system-out></testsuite>`),
    );
    const checks = new MutationChecks();
    checks.start({
      root,
      appData,
      file: 'src/app.mjs',
      environmentId: stand.id,
      secrets: () => ({ values: { E2E_SECRET_TOKEN: SECRET }, missing: [] }),
    });
    const check = await finished(checks);
    expect(check).toMatchObject({ status: 'done', caught: 1 });
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as {
      baseUrl: string | null;
      secret: string | null;
    };
    expect(argv).toMatchObject({ baseUrl: 'https://stand.example.com', secret: SECRET });
    expect(check?.log).not.toContain(SECRET);
  }, 90_000);

  it('конфиг сам поднимает приложение (webServer) — стенд не нужен', async () => {
    writeFileSync(
      join(root, 'e2e', 'playwright.config.ts'),
      "export default { webServer: { command: 'npm start', url: 'http://localhost:3000' } };\n",
    );
    const checks = new MutationChecks();
    checks.start({ root, appData, file: 'src/app.mjs' });
    const check = await finished(checks);
    expect(check).toMatchObject({ status: 'done', caught: 1 });
  }, 90_000);
});
