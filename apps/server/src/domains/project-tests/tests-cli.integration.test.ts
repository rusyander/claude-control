import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TESTS_PROJECT_ENV } from '@agentdeck/contracts/chat-group-settings';
import {
  applyResults,
  createGroup,
  parseCase,
  readGroups,
  upsertCase,
  writeGroup,
} from './store/store.ts';
import { readRuns, writeRun } from './runs-store/runs-store.ts';
import { syncE2eFolder } from './e2e-sync/e2e-sync.ts';
import { installFakeRunners, markRunnerInstalled } from './__fixtures__/fake-runners.ts';
import { playwrightFileArg } from './e2e-command/e2e-command.ts';

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

  /**
   * Группа Claude получает строку о тестах без путей, а проект — в окружении
   * (X1): команда из любого каталога без `--project` обязана найти проект
   * группы, а явный `--project` — по-прежнему главнее окружения.
   */
  it('без --project проект берётся из окружения группы, явный --project главнее, без обоих — текущий каталог', () => {
    const other = mkdtempSync(join(tmpdir(), 'cc-tests-cli-other-'));
    try {
      createGroup(other, 'api', 'API');
      upsertCase(other, 'api', { title: 'Токен', steps: ['запросить'] }, now);
      // Тест сам может идти внутри группы — её проект в окружении не должен подыграть.
      const clean = { ...process.env };
      delete clean[TESTS_PROJECT_ENV];
      const list = (env: NodeJS.ProcessEnv, ...args: string[]) => {
        const result = spawnSync(process.execPath, [CLI, 'list', ...args], {
          cwd: other,
          env,
          encoding: 'utf8',
          timeout: 60_000,
        });
        return { code: result.status, out: `${result.stdout}${result.stderr}` };
      };

      const fromEnv = list({ ...clean, [TESTS_PROJECT_ENV]: project });
      expect(fromEnv.code).toBe(0);
      expect(fromEnv.out).toContain('gui-001');
      expect(fromEnv.out).not.toContain('api-001');

      const explicit = list({ ...clean, [TESTS_PROJECT_ENV]: project }, '--project', other);
      expect(explicit.out).toContain('api-001');
      expect(explicit.out).not.toContain('gui-001');

      const fromCwd = list(clean);
      expect(fromCwd.out).toContain('api-001');
      expect(fromCwd.out).not.toContain('gui-001');
    } finally {
      rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
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

  /**
   * Память проверок (9.3) папку e2e не берёт: тесты идут по стенду, а стенд
   * меняется без единой правки в файлах — зелёный вчерашнего стенда не ответ.
   */
  it('папка e2e по стенду гоняется каждый раз, даже с --memo на том же дереве', () => {
    markRunnerInstalled(join(project, 'e2e'), 'playwright');
    setEnv('FAKE_E2E_JUNIT', JUNIT.replace('<failure message="нет ошибки"/>', ''));
    setEnv('FAKE_E2E_EXIT', '0');
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x', ...args], { cwd: project });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'init');

    expect(cli(project, 'run', '--memo').code).toBe(0);
    const again = cli(project, 'run', '--memo');

    expect(again.code).toBe(0);
    expect(again.out).not.toContain('Без изменений');
    expect(readRuns(project)).toHaveLength(2);
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

  /** Раннер, пишущий отчёт туда, куда велит строка: `--out=<путь>`. */
  const GREEN = `import { writeFileSync } from 'node:fs';
const out = process.argv.find((arg) => arg.startsWith('--out=')).slice(6);
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
writeFileSync(out, '<testsuites><testsuite name="qa">' +
  '<testcase name="[qa-001] панель открывается" classname="qa"/>' +
  '<testcase name="[qa-002] поиск находит" classname="qa"/></testsuite></testsuites>');
`;
  const commitAll = () => {
    const git = (...args: string[]) =>
      spawnSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=x', ...args], { cwd: project });
    // След раннера — не правка дерева.
    writeFileSync(join(project, '.gitignore'), 'argv.json\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-qm', 'init');
  };

  /**
   * Живой прогон 19.10.2026: `run --cmd "… --outputFile={report}"` отдал
   * раннеру `{report}` буквально — отчёт лёг в копию файлом с этим именем,
   * статусы не проставились.
   */
  it('--cmd с {report}: отчёт этого прогона во временном файле, импортирован, в проекте ничего', () => {
    writeFileSync(join(project, 'green.mjs'), GREEN);
    const result = cli(
      project,
      'run',
      '--group',
      'qa',
      '--cmd',
      'node green.mjs {paths} --out={report}',
    );
    expect(result.code).toBe(0);
    const args = argv();
    expect(args.slice(0, 2)).toEqual(['tools/qa/open.mjs', 'tools/qa/search.mjs']);
    expect(args[2]).toMatch(/^--out=.*cc-tests-run-.*junit\.xml$/);
    expect(existsSync(join(project, '{report}'))).toBe(false);
    const [record] = readRuns(project);
    expect(record).toMatchObject({ origin: 'ci', exitCode: 0, summary: { passed: 2 } });
  });

  /**
   * Память проверок (9.3) отвечает на тот же прогон того же дерева. Путь
   * отчёта в строке — свежий временный каталог: ключ с ним не совпадал ни разу.
   */
  it('--memo: своя команда с {report} на том же дереве второй раз отвечает из памяти', () => {
    writeFileSync(join(project, 'green.mjs'), GREEN);
    automation({ version: 1, command: 'node green.mjs {files} --out={report}' });
    commitAll();
    expect(cli(project, 'run', '--memo').code).toBe(0);
    const again = cli(project, 'run', '--memo');
    expect(again.code).toBe(0);
    expect(again.out).toContain('Без изменений с зелёного прогона');
    const viaCmd = cli(project, 'run', '--memo', '--cmd', 'node green.mjs --out={report}');
    expect(viaCmd.out).not.toContain('Без изменений');
    expect(cli(project, 'run', '--memo', '--cmd', 'node green.mjs --out={report}').out).toContain(
      'Без изменений с зелёного прогона',
    );
  });

  /**
   * L7.3 плана экономии групп: проверка доставки просила прогнать кейсы
   * изменённых файлов, а единственной командой был прогон всех кейсов копии.
   */
  it('--case сужает прогон до названных кейсов; голый id — если он один в проекте', () => {
    // {paths} пуст у прогона без выбора: выбор кейсами обязан до него дойти.
    automation({ version: 1, command: 'node run.mjs {paths}' });
    const result = cli(project, 'run', '--case', 'qa:qa-002,ot-001');
    expect(result.out).toContain('Кейсов с автотестом: 2, файлов: 2');
    expect(argv()).toEqual(['tools/qa/other.mjs', 'tools/qa/search.mjs']);
    expect(readRuns(project)[0]?.scope).toBe(
      'tests-cli run: node run.mjs tools/qa/other.mjs tools/qa/search.mjs',
    );
  });

  it('--case с кейсом, которого нет, — отказ словами, ничего не запущено', () => {
    const result = cli(project, 'run', '--case', 'qa:qa-001,qa:nope');
    expect(result.code).toBe(1);
    expect(result.out).toContain('Кейсов нет в проекте: qa:nope');
    expect(existsSync(join(project, 'argv.json'))).toBe(false);
    expect(readRuns(project)).toHaveLength(0);
  });

  it('сломанный automation.json — отказ словами, а не тихий откат на npm test', () => {
    automation({ version: 1 });
    const result = cli(project, 'run');
    expect(result.code).toBe(1);
    expect(result.out).toContain('automation.json: В файле команды прогона нет строки «command»');
    expect(readRuns(project)).toHaveLength(0);
  });

  /**
   * 2.2 плана экономии: полный вывод прогона в контексте агента группы
   * перечитывается каждым следующим вызовом. Группе (`AGENTDECK_BRIEF_OUTPUT`,
   * его ставит панель ребёнку разделения) — итог, первые строки падений и путь
   * к журналу, где лежит всё; `--full` возвращает прежнее, без метки — как было.
   */
  describe('короткий вывод для группы', () => {
    const NOISY = `${RUNNER.replace('process.exit(1);', '')}
for (let i = 1; i <= 300; i += 1) console.log('шум строка ' + i);
console.error('FAIL tools/qa/search.mjs > поиск находит');
process.exit(1);
`;
    const run = (env: Record<string, string>, ...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, 'run', ...args, '--project', project], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, ...env },
      });
      return { code: result.status, out: `${result.stdout}${result.stderr}` };
    };

    beforeEach(() => writeFileSync(join(project, 'run.mjs'), NOISY));

    it('с меткой группы: итог, строка падения и журнал, где лежит весь вывод', () => {
      const result = run({ AGENTDECK_BRIEF_OUTPUT: '1' });
      expect(result.code).toBe(1);
      expect(result.out).not.toContain('шум строка 150');
      expect(result.out).toContain('FAIL tools/qa/search.mjs > поиск находит');
      const log = /Полный вывод \((\d+) строк\): (.+)$/m.exec(result.out);
      expect(log?.[1]).toBe('301');
      const text = readFileSync(log?.[2]?.trim() ?? '', 'utf8');
      expect(text).toContain('шум строка 150');
      expect(text).toContain('FAIL tools/qa/search.mjs > поиск находит');
      // Импорт и запись истории — как без метки.
      expect(readRuns(project)[0]).toMatchObject({ summary: { passed: 1, failed: 1 } });
    });

    it('--full и прогон без метки печатают всё, как прежде', () => {
      expect(run({ AGENTDECK_BRIEF_OUTPUT: '1' }, '--full').out).toContain('шум строка 150');
      expect(run({ AGENTDECK_BRIEF_OUTPUT: '' }).out).toContain('шум строка 150');
      expect(run({ AGENTDECK_BRIEF_OUTPUT: '' }, '--brief').out).not.toContain('шум строка 150');
    });
  });
});

/**
 * Монорепозиторий (19.10.2026): кейсы-наборы двух пакетов с одним ключом от
 * корня пакета. `import`/`run` с `--group` кладут результат на набор этой
 * группы — без неё ключ двусмыслен, и группа переписывала отчёт своим скриптом.
 */
describe('tests-cli: наборы пакетов монорепозитория', () => {
  let project = '';
  const REPORT =
    '<testsuites><testsuite name="vitest">' +
    '<testcase classname="src/models/a.test.ts" name="a &gt; считает"/>' +
    '</testsuite></testsuites>';
  const status = (group: string) =>
    readGroups(project).find((g) => g.id === group)?.cases[0]?.status;

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-mono-')));
    for (const [group, pkg] of [
      ['suites-admin', 'admin-ui'],
      ['suites-chat', 'chat-ui'],
    ] as const) {
      const automation = { status: 'automated', file: `${pkg}/src/models/`, suite: 'src/models' };
      writeGroup(project, {
        ...createGroup(project, group, group),
        cases: [{ id: `${group}-001`, title: `${pkg}: models`, automation }].flatMap(
          (raw, index) => parseCase(raw, index) ?? [],
        ),
      });
    }
    writeFileSync(join(project, 'report.xml'), REPORT);
    writeFileSync(
      join(project, 'pkg.mjs'),
      `import { copyFileSync } from 'node:fs';\ncopyFileSync('report.xml', process.argv.at(-1));\n`,
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('import --group: результат на наборе группы, чужой не тронут', () => {
    const result = cli(
      project,
      'import',
      '--format',
      'junit',
      '--file',
      'report.xml',
      '--group',
      'suites-admin',
    );
    expect(result.code).toBe(0);
    expect(status('suites-admin')).toBe('passed');
    expect(status('suites-chat')).toBe('unknown');
  });

  it('import --group несуществующей группы — отказ словами, статусы не тронуты', () => {
    const result = cli(
      project,
      'import',
      '--format',
      'junit',
      '--file',
      'report.xml',
      '--group',
      'nope',
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain('Группы «nope» в проекте нет');
    expect(readRuns(project)).toHaveLength(0);
  });

  it('run --group: отчёт прогона ложится на набор этой группы', () => {
    const result = cli(
      project,
      'run',
      '--group',
      'suites-chat',
      '--cmd',
      'node pkg.mjs {paths} {report}',
    );
    expect(result.code).toBe(0);
    expect(status('suites-chat')).toBe('passed');
    expect(status('suites-admin')).toBe('unknown');
  });
});

/**
 * Кейсы vitest в проекте, чья своя команда — цепочка `go test` (19.10.2026:
 * `{go-modules}` отдавал `*.test.ts` в go, и группа собирала JUnit руками).
 * Настоящий vitest панели: в каждый пакет — ссылка на node_modules сервера.
 */
describe('tests-cli run: кейсы vitest мимо своей команды Go', () => {
  let project = '';
  const MODULES = resolve(__dirname, '../../../node_modules');
  const status = (id: string) =>
    readGroups(project)
      .flatMap((g) => g.cases)
      .find((c) => c.id === id)?.status;
  const run = (group: string, projectArg = project) => {
    const result = spawnSync(
      process.execPath,
      [CLI, 'run', '--group', group, '--project', projectArg],
      { encoding: 'utf8', timeout: 120_000 },
    );
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  };

  beforeEach(() => {
    project = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-tests-cli-vitest-')));
    // Набор admin заодно сверяет каталог ГЛАВНОГО процесса vitest (его отдаёт конфиг
    // пакета): vitest идёт из каталога пакета, а не из корня проекта — `--root` cwd не
    // меняет, а Babel трансформа ищет плагины от cwd. Рабочие процессы vitest и так
    // стартуют в `--root`, поэтому `process.cwd()` внутри теста этого не различает.
    const adminDir = JSON.stringify(join(project, 'admin').toLowerCase());
    for (const [pkg, body] of [
      [
        'admin',
        `import { realpathSync } from 'node:fs';\n` +
          `describe('a', () => { it('считает', () => {\n` +
          `  expect(1 + 1).toBe(2);\n` +
          `  expect(realpathSync.native(process.env.PKG_MAIN_CWD).toLowerCase()).toBe(${adminDir});\n` +
          `}); });`,
      ],
      ['chat', `describe('b', () => { it('падает', () => expect(1).toBe(2)); });`],
    ] as const) {
      mkdirSync(join(project, pkg, 'src'), { recursive: true });
      writeFileSync(join(project, pkg, 'package.json'), `{"name":"${pkg}","type":"module"}`);
      writeFileSync(
        join(project, pkg, 'src', `${pkg}.test.ts`),
        `import { describe, it, expect } from 'vitest';\n${body}\n`,
      );
      symlinkSync(MODULES, join(project, pkg, 'node_modules'), 'junction');
    }
    writeFileSync(
      join(project, 'admin', 'vitest.config.mjs'),
      'export default { test: { env: { PKG_MAIN_CWD: process.cwd() } } };\n',
    );
    writeGroup(project, {
      ...createGroup(project, 'web', 'web'),
      cases: [
        {
          id: 'web-001',
          title: 'админка считает',
          automation: {
            status: 'automated',
            file: 'admin/src/admin.test.ts',
            testName: 'a > считает',
          },
        },
        {
          id: 'web-002',
          title: 'чат падает',
          automation: {
            status: 'automated',
            file: 'chat/src/chat.test.ts',
            testName: 'b > падает',
          },
        },
      ].flatMap((raw, index) => parseCase(raw, index) ?? []),
    });
    // Наборы с одним ключом `src` в двух пакетах: без перевода classname к корню
    // проекта ключ двусмыслен, и оба итога терялись.
    writeGroup(project, {
      ...createGroup(project, 'suites', 'suites'),
      cases: ['admin', 'chat']
        .map((pkg) => ({
          id: `suites-${pkg}`,
          title: `${pkg}: src`,
          automation: { status: 'automated', file: `${pkg}/src/`, suite: 'src' },
        }))
        .flatMap((raw, index) => parseCase(raw, index) ?? []),
    });
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: '{go-modules}', format: 'go-test-json' }),
    );
  });

  afterEach(() => {
    // unlink, а не rmSync: на Windows ссылка — junction, и rmSync без recursive отказывает
    // «Path is a directory», роняя тест после зелёных проверок.
    for (const pkg of ['admin', 'chat'])
      try {
        unlinkSync(join(project, pkg, 'node_modules'));
      } catch {
        // ссылки нет — тест упал раньше, чем её создал
      }
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('каждый пакет — своим vitest, итоги на кейсах, провал одного пакета — код 1', () => {
    const result = run('web');
    expect(result.out).toMatch(
      /Команда: \(.*vitest.* run --root .*admin.* \|\| echo -\) && \(.*--root .*chat.* \|\| echo -\)/,
    );
    expect(result.out).not.toContain('go test');
    expect(result.code).toBe(1);
    expect(status('web-001')).toBe('passed');
    expect(status('web-002')).toBe('failed');
    expect(readRuns(project)[0]).toMatchObject({ exitCode: 1, summary: { passed: 1, failed: 1 } });
  }, 150_000);

  // `--project "d:\…"` — так путь отдаёт VS Code. Vite на Windows считает `d:/…` и `D:/…`
  // разными модулями: без заглавной буквы диска тест получал второй `vitest` без раннера,
  // и каждый файл падал «Vitest failed to find the runner» (widget-app, 22.10.2026). Сам
  // провал здесь не воспроизвести: он нужен vitest настоящими файлами в дереве проекта
  // (hoisted node_modules), а у фикстуры ссылка — realpath сам чинит регистр. Поэтому
  // держится инвариант команды: ни одного пути со строчной буквой диска.
  it.runIf(process.platform === 'win32')(
    'путь проекта со строчной буквой диска — в команду vitest он идёт с заглавной',
    () => {
      const lowerDrive = project.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
      expect(lowerDrive).not.toBe(project);
      const result = run('web', lowerDrive);
      const command = result.out.split('\n').find((line) => line.startsWith('Команда:')) ?? '';
      expect(command).toMatch(/--root /);
      expect(command).not.toMatch(/(^|[\s"'])[a-z]:\\/);
      expect(status('web-001')).toBe('passed');
    },
    150_000,
  );

  it('наборы-каталоги пакетов с одним ключом src — итог каждому своему', () => {
    const result = run('suites');
    expect(result.code).toBe(1);
    expect(status('suites-admin')).toBe('passed');
    expect(status('suites-chat')).toBe('failed');
  }, 150_000);

  it('своя команда JUnit — по-прежнему она, даже для файлов vitest', () => {
    writeFileSync(
      join(project, '.agent', 'tests', 'automation.json'),
      JSON.stringify({ version: 1, command: 'node run.mjs {files}' }),
    );
    const result = cli(project, 'run', '--group', 'web', '--dry');
    expect(result.out).toContain(
      'Команда: node run.mjs admin/src/admin.test.ts chat/src/chat.test.ts',
    );
  });
});
