import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { E2eRunRegistry, e2eReportPath } from './e2e-run.ts';
import { createE2eFolder } from '../e2e-folder/e2e-folder.ts';
import { syncE2eFolder } from '../e2e-sync/e2e-sync.ts';
import { createGroup, parseCase, readGroups, writeGroup } from '../store/store.ts';
import { saveEnvironment } from '../library/library.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { installFakeRunners, markRunnerInstalled } from '../__fixtures__/fake-runners.ts';

/**
 * «Прогнать автотесты» без агента: панель сама запускает команду каркаса через
 * оболочку, ждёт отчёт junit в СВОЁМ каталоге и кладёт его результаты одной
 * строкой истории. Подменён только сам раннер (`npx`/`python` на PATH пишет
 * отчёт, как настоящий), команда, env, разбор и запись — настоящие.
 */

const SPEC = `import { test } from '@playwright/test';
test.describe('Вход', () => {
  test('[auth-001] вход по паролю', async () => {});
  test('[auth-002] неверный пароль', async () => {});
});
`;

const JUNIT =
  '<testsuites><testsuite name="auth.spec.ts">' +
  '<testcase name="Вход › [auth-001] вход по паролю" classname="auth.spec.ts" time="1"/>' +
  '<testcase name="Вход › [auth-002] неверный пароль" classname="auth.spec.ts" time="1">' +
  '<failure message="нет ошибки"/></testcase></testsuite></testsuites>';

const now = '2026-09-26T10:00:00.000Z';
const SECRET = 's3cr3t-token-value';

function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Остаётся в temp.
  }
}

describe('project-tests/e2e-run: прогон автотестов панелью', () => {
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
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-run-')));
    appData = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-e2e-run-data-')));
    spawnSync('git', ['init', '-q'], { cwd: root });
    fake = installFakeRunners();
    argvFile = join(fake.bin, 'argv.json');
    setEnv('FAKE_E2E_ARGV', argvFile);
  });

  afterEach(() => {
    fake.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    dropTemp(root);
    dropTemp(appData);
    dropTemp(fake.bin);
  });

  const secrets = () => ({ values: { E2E_SECRET_TOKEN: SECRET }, missing: [] });
  /** Папка панели с установленным Playwright — как после `npm install` в ней. */
  const panelFolder = (): void => {
    createE2eFolder(appData, root, now);
    markRunnerInstalled(join(root, 'e2e'), 'playwright');
  };

  it('папка панели: команда из неё, красный тест — итог, а не сбой; одна строка истории', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    const stand = saveEnvironment(root, { title: 'Стенд', baseUrl: 'https://stand.example.com' });
    setEnv('FAKE_E2E_JUNIT', JUNIT);

    const registry = new E2eRunRegistry();
    const started = registry.start({ root, appData, secrets, environmentId: stand.id });
    expect(started).toMatchObject({
      status: 'running',
      command: 'npx --no-install playwright test --reporter=list,junit',
    });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });

    const view = registry.get(root);
    expect(view).toMatchObject({ exitCode: 1, imported: { read: 2, matched: 2, unmatched: 0 } });
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as {
      argv: string[];
      cwd: string;
      baseUrl: string | null;
      secret: string | null;
    };
    expect(argv.argv).toEqual(['--no-install', 'playwright', 'test', '--reporter=list,junit']);
    expect(realpathSync.native(argv.cwd)).toBe(join(root, 'e2e'));
    // Адрес выбранного окружения и доступ дошли до раннера его переменными.
    expect(argv.baseUrl).toBe('https://stand.example.com');
    expect(argv.secret).toBe(SECRET);
    // Значение секрета до раннера дошло, а в журнал вида — нет.
    expect(view?.log).toContain('fake runner');
    expect(view?.log).not.toContain(SECRET);
    // Отчёт — в каталоге панели, проект не тронут.
    expect(existsSync(e2eReportPath(appData, root))).toBe(true);
    expect(existsSync(join(root, 'e2e', 'results'))).toBe(false);

    const history = readRuns(root);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: view?.runId,
      mode: 'import',
      origin: 'e2e',
      status: 'done',
      summary: { passed: 1, failed: 1 },
    });
    expect(history[0]?.scope).toContain('Автотесты папки e2e');
    const cases = new Map(readGroups(root).flatMap((group) => group.cases.map((c) => [c.id, c])));
    expect(cases.get('auth-001')).toMatchObject({ status: 'passed', lastRunId: view?.runId });
    expect(cases.get('auth-002')?.status).toBe('failed');
  });

  it('запись прогона не удалась — сбой, а кейсы без ссылки на несуществующий прогон', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    setEnv('FAKE_E2E_JUNIT', JUNIT);
    // Сбой ввода-вывода на границе: на месте каталога прогонов лежит файл.
    writeFileSync(join(root, '.agent', 'tests', 'runs'), 'not a directory');

    const registry = new E2eRunRegistry();
    registry.start({ root, appData, secrets });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'), { timeout: 20_000 });

    expect(registry.get(root)?.errorCode).toBe('e2e-run-import');
    const cases = readGroups(root).flatMap((group) => group.cases);
    expect(cases.map((item) => item.lastRunId ?? null)).toEqual([null, null]);
  });

  /**
   * Тест, спасённый повтором Playwright, в статусе — честно зелёный. Упавшие
   * попытки раннер кладёт в junit только с `PLAYWRIGHT_JUNIT_INCLUDE_RETRIES`
   * (подменный раннер ведёт себя так же), и без флага карантину нечего было бы
   * предложить: история видела бы сплошной зелёный.
   */
  it('повтор раннера: зелёный на повторе доходит до истории числом упавших попыток', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    setEnv(
      'FAKE_E2E_JUNIT',
      '<testsuites><testsuite name="auth.spec.ts">' +
        '<testcase name="Вход › [auth-001] вход по паролю" classname="auth.spec.ts" time="1">' +
        '<flakyFailure message="timeout" type="FAILURE" time="2"><stackTrace>at x</stackTrace></flakyFailure>' +
        '<flakyError message="boom" type="Error" time="1"><stackTrace>at y</stackTrace></flakyError>' +
        '</testcase>' +
        '<testcase name="Вход › [auth-002] неверный пароль" classname="auth.spec.ts" time="1"/>' +
        '</testsuite></testsuites>',
    );
    setEnv('FAKE_E2E_EXIT', '0');

    const registry = new E2eRunRegistry();
    registry.start({ root, appData, secrets });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });

    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as { includeRetries: string | null };
    expect(argv.includeRetries).toBe('1');
    const results = new Map(readRuns(root)[0]?.results.map((item) => [item.caseId, item]));
    expect(results.get('auth-001')).toMatchObject({ status: 'passed', flakyAttempts: 2 });
    // Признак — число; русской фразы в заметке больше нет (F-355).
    expect(results.get('auth-001')?.note).toBeUndefined();
    expect(results.get('auth-002')?.flakyAttempts).toBeUndefined();
  });

  it('отчёт не появился: вчерашний не выдаётся за сегодняшний, истории нет', async () => {
    panelFolder();
    const report = e2eReportPath(appData, root);
    mkdirSync(join(report, '..'), { recursive: true });
    writeFileSync(report, JUNIT);
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(report, old, old);
    setEnv('FAKE_E2E_MODE', 'none');

    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'), { timeout: 20_000 });
    expect(registry.get(root)).toMatchObject({ errorCode: 'e2e-run-no-report', exitCode: 2 });
    expect(registry.get(root)?.log).toContain('runner not installed');
    expect(readRuns(root)).toEqual([]);
  });

  it('отчёт прошлого прогона со свежей датой тоже не выдаётся за новый: он стёрт до запуска', async () => {
    panelFolder();
    const report = e2eReportPath(appData, root);
    mkdirSync(join(report, '..'), { recursive: true });
    // Прошлый прогон кончился только что — по дате его не отличить.
    writeFileSync(report, JUNIT);
    setEnv('FAKE_E2E_MODE', 'none');

    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'), { timeout: 20_000 });
    expect(registry.get(root)?.errorCode).toBe('e2e-run-no-report');
    expect(readRuns(root)).toEqual([]);
  });

  it('стоп после отчёта — «остановлено», и то, что успело в отчёт, легло записью', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    setEnv('FAKE_E2E_JUNIT', JUNIT);
    setEnv('FAKE_E2E_MODE', 'report-hang');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(existsSync(e2eReportPath(appData, root))).toBe(true), {
      timeout: 20_000,
    });

    registry.stop(root);
    await vi.waitFor(() => expect(registry.get(root)?.finishedAt).toBeDefined(), {
      timeout: 20_000,
    });
    expect(registry.get(root)).toMatchObject({
      status: 'stopped',
      imported: { read: 2, matched: 2, unmatched: 0 },
    });
    expect(readRuns(root)).toEqual([expect.objectContaining({ status: 'stopped' })]);
  });

  it('второй запуск поверх идущего — 409 кодом; стоп — «остановлен», без записи', async () => {
    panelFolder();
    setEnv('FAKE_E2E_MODE', 'hang');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    let refusal: unknown;
    try {
      registry.start({ root, appData });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ messageCode: 'e2e-run-busy', statusCode: 409 });
    // Дать раннеру подняться: убиваем дерево процесса, а не пустую оболочку.
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true), { timeout: 20_000 });

    expect(registry.stop(root)?.status).toBe('stopped');
    // Остановленный ещё закрывается: пока итог не лёг, проект занят — и второй
    // запуск, и агент раздела получают отказ.
    expect(registry.isRunning(root)).toBe(true);
    expect(() => registry.start({ root, appData })).toThrow();
    await vi.waitFor(() => expect(registry.get(root)?.finishedAt).toBeDefined(), {
      timeout: 20_000,
    });
    expect(registry.get(root)?.status).toBe('stopped');
    expect(registry.isRunning(root)).toBe(false);
    expect(readRuns(root)).toEqual([]);
  });

  /** Выход панели: раннер запущен оболочкой и сам с ней не умирает. */
  it('stopAll гасит идущие прогоны; наблюдатель видит их по runningRoots', async () => {
    panelFolder();
    setEnv('FAKE_E2E_MODE', 'hang');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(existsSync(argvFile)).toBe(true), { timeout: 20_000 });
    expect(registry.runningRoots()).toEqual([root]);
    // Конец хода чата и замок прогона агента спрашивают путём «как ввели».
    expect(registry.isRunning(root.replace(/\\/g, '/'))).toBe(true);
    if (process.platform === 'win32') expect(registry.isRunning(root.toLowerCase())).toBe(true);

    registry.stopAll();
    expect(registry.runningRoots()).toEqual([]);
    await vi.waitFor(() => expect(registry.get(root)?.finishedAt).toBeDefined(), {
      timeout: 20_000,
    });
    expect(registry.get(root)?.status).toBe('stopped');
  });

  it('pytest: python -m pytest <папка> --junitxml в каталог панели', async () => {
    mkdirSync(join(root, 'tests', 'e2e'), { recursive: true });
    writeFileSync(
      join(root, 'tests', 'e2e', 'test_login.py'),
      'def test_login():\n    """[login-001] вход"""\n    assert True\n',
    );
    syncE2eFolder(root, now, { dir: 'tests/e2e', appData });
    setEnv(
      'FAKE_E2E_JUNIT',
      '<testsuites><testsuite name="pytest">' +
        '<testcase classname="tests.e2e.test_login" name="test_login" time="0.1"/>' +
        '</testsuite></testsuites>',
    );
    setEnv('FAKE_E2E_EXIT', '0');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as { argv: string[] };
    expect(argv.argv.slice(0, 4)).toEqual(['-m', 'pytest', 'tests/e2e', '-q']);
    expect(argv.argv[4]).toBe(`--junitxml=${e2eReportPath(appData, root)}`);
    expect(registry.get(root)?.imported).toEqual({ read: 1, matched: 1, unmatched: 0 });
    const login = readGroups(root).find((group) => group.id === 'login');
    expect(login?.cases[0]).toMatchObject({ id: 'login-001', status: 'passed' });
  });

  /**
   * Раннер не установлен — отказ ДО запуска. `npx` без раннера скачал бы его
   * последней версии: однажды это были 0,8 ГБ Cypress без спроса.
   */
  it('раннер не установлен: отказ кодом с командой установки, ничего не запущено', () => {
    createE2eFolder(appData, root, now);
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    const registry = new E2eRunRegistry();
    expect(() => registry.start({ root, appData })).toThrow(
      expect.objectContaining({
        messageCode: 'e2e-run-not-installed',
        params: { dir: 'e2e', install: 'npm install && npx playwright install chromium' },
      }),
    );
    expect(existsSync(argvFile)).toBe(false);
    expect(registry.get(root)).toBeUndefined();

    // Cypress в корне проекта: подсказка — поставить его в проект.
    const cypressRoot = join(root, 'cy');
    mkdirSync(join(cypressRoot, 'cypress', 'e2e'), { recursive: true });
    writeFileSync(join(cypressRoot, 'cypress.config.js'), 'module.exports = {};\n');
    writeFileSync(join(cypressRoot, 'cypress', 'e2e', 'a.cy.js'), "it('x', () => {});\n");
    expect(() => registry.start({ root: cypressRoot, appData })).toThrow(
      expect.objectContaining({
        messageCode: 'e2e-run-not-installed',
        params: { dir: '.', install: 'npm install --save-dev cypress' },
      }),
    );
  });

  it('раннер пропал уже после проверки: отказ npx в выводе — тот же код, а не «отчёта нет»', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    setEnv('FAKE_E2E_MODE', 'missing');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'), { timeout: 20_000 });
    expect(registry.get(root)).toMatchObject({
      errorCode: 'e2e-run-not-installed',
      errorParams: { dir: 'e2e', install: 'npm install && npx playwright install chromium' },
    });
    expect(readRuns(root)).toHaveLength(0);
  });

  // Живая проверка 08.10: Playwright в папке обновился, его браузер не скачан —
  // отчёт есть, и все кейсы ложились «упал», будто сломано приложение.
  it('браузер раннера не скачан: отказ «не установлен», кейсы не краснеют, истории нет', async () => {
    panelFolder();
    writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(root, now, { dir: 'e2e', appData });
    setEnv('FAKE_E2E_MODE', 'no-browser');
    const registry = new E2eRunRegistry();
    registry.start({ root, appData });
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'), { timeout: 20_000 });
    expect(registry.get(root)).toMatchObject({
      errorCode: 'e2e-run-not-installed',
      errorParams: { dir: 'e2e', install: 'npm install && npx playwright install chromium' },
    });
    expect(readRuns(root)).toHaveLength(0);
    const statuses = readGroups(root).flatMap((group) => group.cases.map((c) => c.status));
    expect(statuses).not.toContain('failed');
  });

  it('каркас не распознан или папки нет — отказ кодом, ничего не запущено', () => {
    const registry = new E2eRunRegistry();
    expect(() => registry.start({ root, appData })).toThrow(
      expect.objectContaining({ messageCode: 'e2e-missing' }),
    );
    mkdirSync(join(root, 'e2e'));
    writeFileSync(join(root, 'e2e', 'a.spec.ts'), "it('x', () => {});\n");
    expect(() => registry.start({ root, appData })).toThrow(
      expect.objectContaining({ messageCode: 'e2e-run-unknown-framework' }),
    );
    expect(registry.get(root)).toBeUndefined();
    expect(existsSync(argvFile)).toBe(false);
  });

  describe('своя команда проекта (automation.json)', () => {
    /**
     * Команда проекта — настоящий `node` со скриптом в самом проекте: пишет
     * отчёт туда, куда велит панель (`AGENTDECK_JUNIT_REPORT`), и свои аргументы.
     */
    const RUNNER = `import { writeFileSync } from 'node:fs';
const files = process.argv.slice(2);
writeFileSync(process.env.OWN_ARGV, JSON.stringify({ files, report: process.env.AGENTDECK_JUNIT_REPORT }));
if (process.env.OWN_SLEEP) await new Promise((done) => setTimeout(done, Number(process.env.OWN_SLEEP)));
const cases = ['[qa-001] панель открывается', '[qa-002] поиск находит'];
writeFileSync(process.env.AGENTDECK_JUNIT_REPORT, '<testsuites><testsuite name="qa">' +
  cases.map((name) => '<testcase name="' + name + '" classname="qa" time="1"/>').join('') +
  '</testsuite></testsuites>');
`;
    let ownArgv = '';
    const ownProject = (automation: Record<string, unknown>): void => {
      mkdirSync(join(root, 'tools'), { recursive: true });
      writeFileSync(join(root, 'tools', 'run.mjs'), RUNNER);
      mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
      writeFileSync(
        join(root, '.agent', 'tests', 'automation.json'),
        JSON.stringify({ version: 1, ...automation }),
      );
      const group = (id: string, title: string, cases: Record<string, unknown>[]): void =>
        writeGroup(root, {
          ...createGroup(root, id, title),
          cases: cases.flatMap((raw, index) => parseCase(raw, index) ?? []),
        });
      const automated = (file: string) => ({ status: 'automated', file });
      group('qa', 'Проверки', [
        { id: 'qa-001', title: 'панель открывается', automation: automated('tools/qa/open.mjs') },
        { id: 'qa-002', title: 'поиск находит', automation: automated('tools/qa/search.mjs') },
        { id: 'qa-003', title: 'руками', automation: { status: 'manual' } },
      ]);
      group('other', 'Прочее', [
        { id: 'ot-001', title: 'чужое', automation: automated('tools/qa/other.mjs') },
      ]);
      ownArgv = join(appData, 'own-argv.json');
      setEnv('OWN_ARGV', ownArgv);
    };
    const argvOf = () =>
      JSON.parse(readFileSync(ownArgv, 'utf8')) as { files: string[]; report: string };

    it('папки e2e нет: весь набор идёт командой проекта, отчёт — в каталог панели, запись «Автотесты проекта»', async () => {
      ownProject({ command: 'node tools/run.mjs {files}' });
      const registry = new E2eRunRegistry();
      expect(registry.start({ root, appData })).toMatchObject({
        status: 'running',
        command: 'node tools/run.mjs tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs',
      });
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });
      expect(registry.get(root)).toMatchObject({
        exitCode: 0,
        imported: { read: 2, matched: 2, unmatched: 0 },
      });
      // Без выбора {files} — файлы всех кейсов с автотестом, «руками» — мимо.
      expect(argvOf()).toEqual({
        files: 'tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs'.split(' '),
        report: e2eReportPath(appData, root),
      });
      const [record] = readRuns(root);
      expect(record).toMatchObject({ origin: 'e2e', summary: { passed: 2 } });
      expect(record?.scope).toBe(
        'Автотесты проекта: node tools/run.mjs tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs',
      );
      const cases = new Map(readGroups(root).flatMap((group) => group.cases.map((c) => [c.id, c])));
      expect(cases.get('qa-002')).toMatchObject({ status: 'passed', lastRunId: record?.id });
    });

    it('группа и кейсы сужают прогон до их файлов; у выбранных нет автотеста — отказ кодом', async () => {
      ownProject({ command: 'node tools/run.mjs {files}' });
      const registry = new E2eRunRegistry();
      registry.start({ root, appData, groupId: 'qa' });
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });
      expect(argvOf().files).toEqual(['tools/qa/open.mjs', 'tools/qa/search.mjs']);

      registry.start({ root, appData, groupId: 'qa', caseIds: ['qa-002'] });
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });
      expect(argvOf().files).toEqual(['tools/qa/search.mjs']);
      expect(registry.get(root)?.command).toBe('node tools/run.mjs tools/qa/search.mjs');

      writeFileSync(ownArgv, 'untouched');
      expect(() => registry.start({ root, appData, caseIds: ['qa-003'] })).toThrow(
        expect.objectContaining({ messageCode: 'e2e-run-nothing-selected' }),
      );
      expect(readFileSync(ownArgv, 'utf8')).toBe('untouched');
    });

    it('потолок timeoutMinutes: зависшая команда остановлена, в журнале — почему', async () => {
      ownProject({ command: 'node tools/run.mjs', timeoutMinutes: 0.01 });
      setEnv('OWN_SLEEP', '60000');
      const registry = new E2eRunRegistry();
      registry.start({ root, appData });
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('stopped'), {
        timeout: 20_000,
      });
      await vi.waitFor(() => expect(registry.get(root)?.finishedAt).toBeTruthy(), {
        timeout: 20_000,
      });
      expect(registry.get(root)?.log).toContain('Прогон дольше 0.01 мин — остановлен.');
      // F-319: остановка потолком оставляет запись истории, а не только строку журнала.
      const runId = registry.get(root)?.runId;
      expect(runId).toBeTruthy();
      expect(readRuns(root).find((run) => run.id === runId)).toMatchObject({
        status: 'stopped',
        origin: 'e2e',
        messageCode: 'e2e-run-timeout',
      });
    });

    it('папка e2e с тестами важнее своей команды; пустая заготовка — уступает ей', async () => {
      ownProject({ command: 'node tools/run.mjs {files}' });
      panelFolder();
      const registry = new E2eRunRegistry();
      // Заготовка без единого теста: гнать её — пустой прогон, идёт своя команда.
      expect(registry.start({ root, appData }).command).toBe(
        'node tools/run.mjs tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs',
      );
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });

      writeFileSync(join(root, 'e2e', 'auth.spec.ts'), SPEC);
      setEnv('FAKE_E2E_JUNIT', JUNIT);
      expect(registry.start({ root, appData }).command).toBe(
        'npx --no-install playwright test --reporter=list,junit',
      );
      await vi.waitFor(() => expect(registry.get(root)?.status).toBe('done'), { timeout: 20_000 });
      // Запись — по runId: два прогона в одну секунду история упорядочивает по uuid.
      const runId = registry.get(root)?.runId;
      expect(readRuns(root).find((run) => run.id === runId)?.scope).toContain(
        'Автотесты папки e2e',
      );
    });
  });
});
