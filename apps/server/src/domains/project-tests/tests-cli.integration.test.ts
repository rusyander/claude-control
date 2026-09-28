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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyResults,
  createGroup,
  parseCase,
  readGroups,
  upsertCase,
  writeGroup,
} from './store.ts';
import { readRuns, writeRun } from './runs-store.ts';
import { syncE2eFolder } from './e2e-sync.ts';
import { installFakeRunners, markRunnerInstalled } from './__fixtures__/fake-runners.ts';
import { playwrightFileArg } from './e2e-command.ts';

/**
 * `pnpm tests` глазами того, кто его зовёт: настоящий процесс `node
 * tools/tests-cli.mjs` над временным проектом, вывод и код возврата.
 *
 * Команда нужна там, где панели нет (CI, чужой терминал), и обязана говорить то
 * же, что панель: провал с разобранным шагом, сравнение «с прошлым», отказ на
 * негодном вводе, а не молчаливая подмена своим значением.
 */
const CLI = resolve(__dirname, '../../../../../tools/tests-cli.mjs');

function cli(project: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--project', project], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('tests-cli', () => {
  let project = '';
  const now = '2026-09-20T10:00:00.000Z';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-cli-'));
    createGroup(project, 'gui', 'GUI');
    upsertCase(
      project,
      'gui',
      { title: 'Вход', steps: [{ action: 'открыть', expected: 'видна форма' }] },
      now,
    );
    upsertCase(project, 'gui', { title: 'Выход', steps: ['нажать'] }, now);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const run = (id: string, startedAt: string, first: 'passed' | 'failed') =>
    writeRun(project, {
      id,
      mode: 'manual',
      actor: 'human',
      status: 'done',
      startedAt,
      finishedAt: startedAt,
      results: [
        { pointId: 'gui|gui-001', groupId: 'gui', caseId: 'gui-001', status: first },
        { pointId: 'gui|gui-002', groupId: 'gui', caseId: 'gui-002', status: 'passed' },
      ],
      summary: {
        total: 2,
        passed: first === 'passed' ? 2 : 1,
        failed: first === 'failed' ? 1 : 0,
        skipped: 0,
        blocked: 0,
      },
    });

  /**
   * Человек отметил красный шаг с заметкой к ШАГУ, общую заметку оставил
   * пустой. Разбор лежит в кейсе, а отчёт и `show` печатали только общую
   * заметку — провал в CI выходил безымянным.
   */
  it('report и show называют разобранный провал: шаг, ожидание, что вышло', () => {
    applyResults(
      project,
      [
        {
          groupId: 'gui',
          caseId: 'gui-001',
          status: 'failed',
          note: '',
          failure: { step: 1, expected: 'видна форма', actual: 'белый экран' },
        },
      ],
      now,
    );

    const report = cli(project, 'report');
    expect(report.code).toBe(1);
    expect(report.out).toMatch(/gui\/gui-001 Вход — шаг 1: белый экран \(ожидалось: видна форма\)/);

    const show = cli(project, 'show', 'gui-001');
    expect(show.out).toMatch(/Провал: шаг 1 · ожидалось: видна форма · получилось: белый экран/);
  });

  /** Панель сравнивает прогон с ближайшим прошлым сама; терминал требовал два id. */
  it('diff с одним прогоном сравнивает его с ближайшим прошлым, без аргументов — последний', () => {
    run('aaaaaaaa-1', '2026-09-20T10:00:00.000Z', 'passed');
    run('bbbbbbbb-2', '2026-09-21T10:00:00.000Z', 'failed');
    run('cccccccc-3', '2026-09-22T10:00:00.000Z', 'passed');

    // Названный прогон — не последний: сравнивается ИМЕННО он, с его прошлым.
    const one = cli(project, 'diff', 'bbbbbbbb-2');
    expect(one.out).toMatch(/база:\s+aaaaaaaa-1/);
    expect(one.out).toMatch(/новый:\s+bbbbbbbb-2/);
    expect(one.out).toMatch(/Новые провалы: 1/);
    expect(one.code).toBe(1);

    const latest = cli(project, 'diff');
    expect(latest.out).toMatch(/база:\s+bbbbbbbb-2/);
    expect(latest.out).toMatch(/новый:\s+cccccccc-3/);
    expect(latest.out).toMatch(/Починилось: 1/);
    expect(latest.code).toBe(0);
  });

  /**
   * Прогон автотестов панелью и отчёт сборки оба пишутся `mode:'import'`, и
   * «режим import» в сравнении их не различал: из терминала не понять, сошлись
   * ли своя машина и конвейер. Старая запись без поля читается импортом из CI.
   */
  it('diff называет происхождение импорта: автотесты панели против CI', () => {
    const base = { actor: 'ci' as const, status: 'done' as const, finishedAt: now };
    const results = [
      { pointId: 'gui|gui-001', groupId: 'gui', caseId: 'gui-001', status: 'passed' as const },
    ];
    const summary = { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 };
    writeRun(project, {
      ...base,
      id: 'aaaaaaaa-1',
      mode: 'import',
      startedAt: '2026-09-20T10:00:00.000Z',
      results,
      summary,
    });
    writeRun(project, {
      ...base,
      id: 'bbbbbbbb-2',
      mode: 'import',
      origin: 'e2e',
      startedAt: '2026-09-21T10:00:00.000Z',
      results,
      summary,
    });

    const out = cli(project, 'diff').out;
    expect(out).toMatch(/база:\s+aaaaaaaa-1 .* · режим import · импорт из CI/);
    expect(out).toMatch(/новый:\s+bbbbbbbb-2 .* · режим import · автотесты панели/);
  });

  // CI после первого прогона пишет тот же `pnpm tests diff`: код 1 только за НОВЫЕ
  // провалы, а новых без прошлого нет — красный конвейер ни за что (ревью 26.09).
  it('diff без прошлого прогона говорит, что сравнивать не с чем, и не валит CI', () => {
    run('aaaaaaaa-1', '2026-09-20T10:00:00.000Z', 'failed');

    const result = cli(project, 'diff');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/сравнивать не с чем/i);
    expect(result.out).not.toMatch(/Ошибка:/);
  });

  it('diff без единого прогона с результатами — тоже не провал', () => {
    const result = cli(project, 'diff');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/сравнивать не с чем/i);
  });

  it('названный, но отсутствующий прогон — по-прежнему ошибка', () => {
    const result = cli(project, 'diff', 'zzzzzzzz-9');
    expect(result.code).toBe(1);
  });

  /** «--budget abc» молча превращался в 30 минут по умолчанию. */
  it('негодный бюджет и порог отвергаются с именем опции', () => {
    const budget = cli(project, 'plan', 'smoke', '--budget', 'abc');
    expect(budget.code).toBe(1);
    expect(budget.out).toMatch(/--budget.*«abc»/);

    const zero = cli(project, 'plan', 'smoke', '--budget', '0');
    expect(zero.code).toBe(1);

    const threshold = cli(project, 'plan', 'flaky', '--threshold', '150');
    expect(threshold.code).toBe(1);
    expect(threshold.out).toMatch(/--threshold/);
  });
});

/**
 * `tests-cli run` — настоящий процесс над временным проектом с папкой e2e;
 * подменены только `npx`/`python` на PATH (граница процесса раннера).
 */
describe('tests-cli run', () => {
  let project = '';
  let fake: ReturnType<typeof installFakeRunners>;
  let argvFile = '';
  const saved: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string): void => {
    if (!(key in saved)) saved[key] = process.env[key];
    process.env[key] = value;
  };
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

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-run-')));
    mkdirSync(join(project, 'e2e'));
    writeFileSync(join(project, 'e2e', 'playwright.config.ts'), 'export default {};\n');
    writeFileSync(join(project, 'e2e', 'auth.spec.ts'), SPEC);
    syncE2eFolder(project, '2026-09-26T10:00:00.000Z', { dir: 'e2e' });
    fake = installFakeRunners();
    argvFile = join(fake.bin, 'argv.json');
    setEnv('FAKE_E2E_ARGV', argvFile);
    setEnv('FAKE_E2E_JUNIT', JUNIT);
  });

  afterEach(() => {
    fake.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete saved[key];
    }
    for (const target of [project, fake.bin]) {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  /**
   * Аудит: после прошлого прогона в проекте лежал отчёт, команда вышла с кодом
   * 3 до тестов — а CLI «обновил 4 кейса» и написал запись истории о прогоне,
   * которого не было.
   */
  it('отчёт старше прогона не импортируется: код команды, статусы и история не тронуты', () => {
    mkdirSync(join(project, 'e2e', 'results'));
    const stale = join(project, 'e2e', 'results', 'junit.xml');
    writeFileSync(stale, JUNIT);
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(stale, past, past);

    const result = cli(project, 'run', '--cmd', 'node -e "process.exit(3)"');
    expect(result.code).toBe(3);
    expect(result.out).toContain('старше этого прогона');
    expect(readRuns(project)).toHaveLength(0);
    const cases = readGroups(project).flatMap((group) => group.cases);
    expect(cases.map((item) => item.status)).toEqual(['unknown', 'unknown']);
  });

  /**
   * Аудит: строка чата велела `run --cmd "<команда проекта>"` из корня — у
   * папки панели это «No tests found» и чужая версия Playwright. Без --cmd
   * берётся команда папки: из каталога её конфига, отчёт — этого прогона.
   */
  it('без --cmd: команда папки e2e из её каталога, запись «автотесты» с кодом выхода', () => {
    markRunnerInstalled(join(project, 'e2e'), 'playwright');
    const result = cli(project, 'run');
    expect(result.code).toBe(1);
    const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as { argv: string[]; cwd: string };
    expect(argv.argv).toEqual([
      '--no-install',
      'playwright',
      'test',
      // F-307: файл — регулярка по концу пути, как её видит сам Playwright.
      playwrightFileArg('e2e/auth.spec.ts').slice(1, -1),
      '--reporter=list,junit',
    ]);
    expect(realpathSync.native(argv.cwd)).toBe(join(project, 'e2e'));
    // Отчёт — во временном файле этого прогона, в проект ничего не легло.
    expect(existsSync(join(project, 'test-results'))).toBe(false);
    expect(existsSync(join(project, 'e2e', 'results'))).toBe(false);

    const history = readRuns(project);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      mode: 'import',
      origin: 'e2e',
      exitCode: 1,
      summary: { passed: 1, failed: 1 },
    });
    expect(history[0]?.scope).toContain('tests-cli run: npx --no-install playwright test');
  });

  it('раннер не установлен: отказ с командой установки, ничего не запущено', () => {
    const result = cli(project, 'run');
    expect(result.code).toBe(1);
    expect(result.out).toContain('Раннер автотестов не установлен');
    expect(result.out).toContain('npm install && npx playwright install chromium');
    expect(existsSync(argvFile)).toBe(false);
    expect(readRuns(project)).toHaveLength(0);
  });
});

/**
 * Проект без папки e2e, чьи проверки — свои скрипты: команду он называет сам в
 * `.agent/tests/automation.json`, и `run` без `--cmd` берёт её, а не npm test.
 * Команда — настоящий `node` со скриптом в проекте, отчёт — куда велит CLI.
 */
describe('tests-cli run: своя команда проекта', () => {
  let project = '';
  const RUNNER = `import { writeFileSync } from 'node:fs';
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.AGENTDECK_JUNIT_REPORT, '<testsuites><testsuite name="qa">' +
  '<testcase name="[qa-001] панель открывается" classname="qa"/>' +
  '<testcase name="[qa-002] поиск находит" classname="qa"><failure message="нет"/></testcase>' +
  '</testsuite></testsuites>');
process.exit(1);
`;
  const automation = (body: unknown): void =>
    writeFileSync(join(project, '.agent', 'tests', 'automation.json'), JSON.stringify(body));

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-own-')));
    writeFileSync(join(project, 'run.mjs'), RUNNER);
    // npm test тоже есть — своя команда обязана быть важнее него.
    writeFileSync(join(project, 'package.json'), '{"scripts":{"test":"node -e 1"}}');
    const group = (id: string, cases: Record<string, unknown>[]): void =>
      writeGroup(project, {
        ...createGroup(project, id, id),
        cases: cases.flatMap((raw, index) => parseCase(raw, index) ?? []),
      });
    const automated = (file: string) => ({ status: 'automated', file });
    group('qa', [
      { id: 'qa-001', title: 'панель открывается', automation: automated('tools/qa/open.mjs') },
      { id: 'qa-002', title: 'поиск находит', automation: automated('tools/qa/search.mjs') },
    ]);
    group('other', [{ id: 'ot-001', title: 'чужое', automation: automated('tools/qa/other.mjs') }]);
    automation({ version: 1, command: 'node run.mjs {files}' });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const argv = () => JSON.parse(readFileSync(join(project, 'argv.json'), 'utf8')) as string[];

  it('без --cmd и без папки e2e: команда из automation.json, файлы всех кейсов, запись «автотесты»', () => {
    const result = cli(project, 'run');
    expect(result.out).toContain(
      'Команда: node run.mjs tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs',
    );
    expect(result.code).toBe(1);
    expect(argv()).toEqual('tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs'.split(' '));
    const [record] = readRuns(project);
    expect(record).toMatchObject({ origin: 'e2e', exitCode: 1, summary: { passed: 1, failed: 1 } });
    expect(record?.scope).toBe(
      'tests-cli run: node run.mjs tools/qa/other.mjs tools/qa/open.mjs tools/qa/search.mjs',
    );
    // Отчёт — во временном файле, в проект он не лёг.
    expect(existsSync(join(project, 'junit.xml'))).toBe(false);
  });

  it('list: названия в одном столбце и при id длиннее 12 знаков', () => {
    writeGroup(project, {
      ...createGroup(project, 'long', 'Длинные'),
      cases: [
        { id: 'panel-agent-0001', title: 'первый' },
        { id: 'x-1', title: 'второй' },
      ].flatMap((raw, index) => parseCase(raw, index) ?? []),
    });
    const lines = cli(project, 'list', '--group', 'long').out.split('\n');
    const column = (title: string) => lines.find((line) => line.endsWith(title))?.indexOf(title);
    expect(column('первый')).toBeGreaterThan(0);
    expect(column('второй')).toBe(column('первый'));
  });

  it('--group сужает прогон до файлов группы', () => {
    cli(project, 'run', '--group', 'qa');
    expect(argv()).toEqual(['tools/qa/open.mjs', 'tools/qa/search.mjs']);
  });

  it('сломанный automation.json — отказ словами, а не тихий откат на npm test', () => {
    automation({ version: 1 });
    const result = cli(project, 'run');
    expect(result.code).toBe(1);
    expect(result.out).toContain('automation.json: В файле команды прогона нет строки «command»');
    expect(readRuns(project)).toHaveLength(0);
  });
});
