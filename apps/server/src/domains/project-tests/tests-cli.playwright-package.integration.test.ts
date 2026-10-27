import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, upsertCase } from './store/store.ts';
import { readRuns } from './runs-store/runs-store.ts';

/**
 * T1 (g5 25.10): кейсы спеков пакета Playwright (`QA/auto/frontend`, свой
 * playwright.config.ts, `@playwright/test` в зависимостях) уходили в vitest пакета —
 * «vitest не установлен», и группа гоняла Playwright руками четырьмя `--cmd`.
 *
 * Здесь настоящий раннер Playwright из node_modules репозитория (тесты без браузера):
 * настоящий разбор фильтров по пути и настоящий JUnit с classname от корня пакета
 * через `path.sep`. Пакет — во временном проекте, рядом спек, который не выбран.
 */
const REPO = resolve(__dirname, '../../../../..');
const CLI = join(REPO, 'tools/tests-cli.mjs');
const PKG = 'QA/auto/frontend';
const SPEC = (title: string) =>
  `import { test, expect } from 'playwright/test';\ntest('${title}', () => { expect(1).toBe(1); });\n`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

describe('tests-cli: кейсы пакета Playwright идут его раннером', { timeout: 180_000 }, () => {
  let dir = '';
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args, '--project', dir], {
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, AGENTDECK_BRIEF_OUTPUT: '', CI: '1' },
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-tests-cli-pw-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '.agent/\nnode_modules/\n');
    // Не папка `e2e` у корня: её ведёт своя команда папки e2e, а пакет QA/auto/frontend
    // (как в монорепозитории) — нет.
    write(dir, {
      [`${PKG}/package.json`]: JSON.stringify({
        name: 'frontend',
        private: true,
        type: 'module',
        // vitest в зависимостях тоже (смешанный пакет): Playwright узнаётся по своему конфигу.
        devDependencies: { playwright: '1.61.1', vitest: '4.1.10' },
      }),
      [`${PKG}/playwright.config.mjs`]: "export default { testDir: '.', workers: 1 };\n",
      [`${PKG}/inst/users/users.spec.mjs`]: SPEC('users list'),
      [`${PKG}/inst/other/other.spec.mjs`]: SPEC('other page'),
      [`${PKG}/inst/extra/extra.spec.mjs`]: SPEC('extra page'),
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
    // Своя команда проекта — Go, как в монорепозитории: кейсы JS она не берёт, их ведут пакеты.
    writeFileSync(
      join(dir, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: '{go-modules}', format: 'go-test-json' }),
    );
    upsertCase(
      dir,
      'qa',
      {
        title: 'Набор inst/users',
        steps: ['playwright test inst/users'],
        expected: 'users list проходит',
        codePaths: [`${PKG}/inst/users`],
        automation: { status: 'automated', file: `${PKG}/inst/users/`, suite: 'inst/users' },
      },
      '2026-10-25T09:00:00.000Z',
    );
    upsertCase(
      dir,
      'qa',
      {
        title: 'Спек other',
        steps: ['playwright test other.spec.mjs'],
        expected: 'other page проходит',
        codePaths: [`${PKG}/inst/other`],
        automation: {
          status: 'automated',
          file: `${PKG}/inst/other/other.spec.mjs`,
          // Весь файл: testName — путь файла от корня проекта. Playwright на Windows пишет
          // classname через `\` — без перевода в `/` этот кейс остался бы без результата.
          testName: `${PKG}/inst/other/other.spec.mjs`,
        },
      },
      '2026-10-25T09:00:00.000Z',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('каталог и файл спеков — Playwright пакета, оба кейса зелёные, невыбранный спек не гонится', () => {
    const ran = cli('run', '--case', 'qa:qa-001,qa:qa-002', '--fresh');
    expect(ran.out).not.toContain('vitest не установлен');
    expect(ran.code, ran.out).toBe(0);
    const [record] = readRuns(dir);
    expect(record?.scope).toContain('playwright');
    expect(
      Object.fromEntries((record?.results ?? []).map((item) => [item.caseId, item.status])),
    ).toEqual({ 'qa-001': 'passed', 'qa-002': 'passed' });
    // Отчёт — из настоящего прогона: два теста, третий спек фильтр не пропустил.
    expect(record?.tests).toMatchObject({ passed: 2, failed: 0 });
    expect(ran.out).not.toContain('extra page');
  });

  it('Playwright у пакета не установлен — отказ называет его, не vitest, и истории нет', () => {
    rmSync(join(dir, PKG, 'node_modules'), { recursive: true, force: true });
    const ran = cli('run', '--case', 'qa:qa-001', '--fresh');
    expect(ran.code).toBe(1);
    expect(ran.out).toContain('Playwright не установлен в QA/auto/frontend');
    expect(readRuns(dir)).toHaveLength(0);
  });
});
