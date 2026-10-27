import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importResults, RED_TESTS_LIMIT } from '../import-results/import-results.ts';
import { readRuns } from '../runs-store/runs-store.ts';
import { branchRedTests, narrowToRed, pytestNodeId } from './red-filter.ts';

/**
 * F-03 (g0 25.10): `run --base` прогнал весь набор pytest mod-llmbox (2105 тестов, 2 мин 14 с),
 * чтобы классифицировать один красный тест. Здесь — цепочка, по которой развилка теперь
 * берёт только красное ветки: импорт отчёта пишет упавшие тесты кейса в запись прогона,
 * из записи они становятся node id pytest / `-run` Go / `-t` vitest в строке развилки.
 */
const DIR = 'mod-llmbox/tests';
const RED_TEST = 'test_chart_from_dataframe_becomes_png_under_sandbox_limits';
// Команда группы g0 из разбора (15:16:23), с файлом кейса, который `run` дописал в конец.
const G0_CMD = `set PYTHONPATH=C:/r/.agent/tmp/pyshim&& pytest ${DIR} -q --junitxml="C:/t/junit.xml" ${DIR}/`;

describe('red-filter: развилка гоняет только красное ветки', () => {
  let root = '';
  const exists = (path: string) => existsSync(join(root, path));
  const report = (...cases: string[]) =>
    `<testsuites><testsuite name="pytest">${cases.join('')}</testsuite></testsuites>`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'red-filter-'));
    for (const file of [
      'mod-llmbox/pyproject.toml',
      `${DIR}/test_code_run_libraries.py`,
      `${DIR}/test_tool_loop.py`,
      `${DIR}/sub/test_deep.py`,
      'mod-other/tests/test_code_run_libraries.py',
    ]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    mkdirSync(join(root, '.agent', 'tests'), { recursive: true });
    writeFileSync(
      join(root, '.agent', 'tests', 'suites.tests.json'),
      JSON.stringify({
        version: 1,
        title: 'suites',
        cases: [
          {
            id: 'llm-001',
            title: 'mod-llmbox',
            steps: [],
            automation: { status: 'automated', file: `${DIR}/`, suite: 'mod-llmbox.tests' },
            status: 'unknown',
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('импорт пишет упавшие тесты кейса-набора в запись прогона, развилка берёт их node id', () => {
    importResults(root, {
      format: 'junit',
      content: report(
        '<testcase classname="tests.test_tool_loop" name="test_a"/>',
        `<testcase classname="tests.test_code_run_libraries" name="${RED_TEST}"><failure message="png"/></testcase>`,
        '<testcase classname="tests.test_tool_loop.TestGuard" name="test_b[x-1]"><failure message="нет"/></testcase>',
      ),
    });
    const reds = branchRedTests(readRuns(root));
    expect(reds['suites:llm-001']).toEqual([
      { name: RED_TEST, owner: 'tests.test_code_run_libraries' },
      { name: 'test_b[x-1]', owner: 'tests.test_tool_loop.TestGuard' },
    ]);
    const narrowed = narrowToRed(
      G0_CMD,
      [{ key: 'suites:llm-001', file: `${DIR}/`, tests: reds['suites:llm-001'] }],
      exists,
      'win32',
    );
    expect(narrowed).toEqual({
      line:
        `set PYTHONPATH=C:/r/.agent/tmp/pyshim&& pytest ${DIR}/test_code_run_libraries.py::${RED_TEST} ` +
        `${DIR}/test_tool_loop.py::TestGuard::test_b[x-1] -q --junitxml="C:/t/junit.xml"`,
      runner: 'pytest',
      tests: 2,
    });
  });

  it('красных больше предела — списка нет, и развилка идёт кейсом целиком', () => {
    const many = Array.from(
      { length: RED_TESTS_LIMIT + 1 },
      (_, index) =>
        `<testcase classname="tests.test_tool_loop" name="test_${index}"><failure message="x"/></testcase>`,
    );
    importResults(root, { format: 'junit', content: report(...many) });
    const [run] = readRuns(root);
    expect(run?.results[0]?.status).toBe('failed');
    expect(run?.results[0]?.failedTests).toBeUndefined();
    expect(branchRedTests(readRuns(root))).toEqual({});
    const whole = narrowToRed(G0_CMD, [{ key: 'suites:llm-001', file: `${DIR}/` }], exists);
    expect(whole).toMatchObject({ reason: expect.stringContaining('suites:llm-001') });
  });

  it('зелёный последний прогон ветки снимает старый список: красным он уже не считается', () => {
    const red = `<testcase classname="tests.test_tool_loop" name="test_a"><failure message="x"/></testcase>`;
    importResults(root, { format: 'junit', content: report(red), now: '2026-10-25T10:00:00.000Z' });
    importResults(root, {
      format: 'junit',
      content: report('<testcase classname="tests.test_tool_loop" name="test_a"/>'),
      now: '2026-10-25T11:00:00.000Z',
    });
    expect(branchRedTests(readRuns(root))).toEqual({});
  });

  it('node id: classname от корня модуля, от корня проекта, подкаталог, класс; файл вне каталога — нет', () => {
    const id = (owner: string, name = 'test_x') => pytestNodeId(DIR, { owner, name }, exists);
    expect(id('tests.test_code_run_libraries')).toBe(`${DIR}/test_code_run_libraries.py::test_x`);
    expect(id('mod-llmbox.tests.test_tool_loop.TestA')).toBe(
      `${DIR}/test_tool_loop.py::TestA::test_x`,
    );
    expect(id('test_tool_loop')).toBe(`${DIR}/test_tool_loop.py::test_x`);
    expect(id('tests.sub.test_deep')).toBe(`${DIR}/sub/test_deep.py::test_x`);
    expect(id('mod-other.tests.test_code_run_libraries')).toBeUndefined();
    expect(id('tests.test_missing')).toBeUndefined();
    expect(pytestNodeId(DIR, { name: 'tests.test_tool_loop' }, exists)).toBeUndefined();
  });

  it('тест без файла (ошибка сбора) или каталог не в команде — кейс целиком с причиной', () => {
    const tests = [{ name: 'tests.test_broken' }];
    expect(narrowToRed(G0_CMD, [{ key: 'k', file: DIR, tests }], exists)).toMatchObject({
      reason: expect.stringContaining('не найден файлом'),
    });
    const ok = [{ name: 'test_a', owner: 'tests.test_tool_loop' }];
    expect(
      narrowToRed('pytest -q --junitxml=r.xml', [{ key: 'k', file: DIR, tests: ok }], exists),
    ).toMatchObject({ reason: expect.stringContaining('нет каталога кейса') });
    expect(
      narrowToRed(`cd mod-llmbox && pytest tests`, [{ key: 'k', file: DIR, tests: ok }], exists),
    ).toMatchObject({ reason: expect.stringContaining('меняет каталог') });
    expect(
      narrowToRed(`pytest ${DIR} -k slow`, [{ key: 'k', file: DIR, tests: ok }], exists),
    ).toMatchObject({ reason: expect.stringContaining('уже выбирает') });
  });

  it('go test: -run по корню подтеста, на каждом go test цепочки; (build) и свой -run — целиком', () => {
    const tests = [
      { name: 'TestCallLLMRetries/429', owner: 'example.com/m/pipeline' },
      { name: 'TestCallLLMRetries/500', owner: 'example.com/m/pipeline' },
      { name: 'TestWS', owner: 'example.com/m/ws' },
    ];
    const cases = [{ key: 'k', file: 'inst-api/internal/', tests }];
    const line =
      '(cd a && go test -json ./... || echo -) && (cd b && go test -json ./... || echo -)';
    expect(narrowToRed(line, cases, exists, 'win32')).toEqual({
      line:
        '(cd a && go test -run "^(TestCallLLMRetries|TestWS)$" -json ./... || echo -) && ' +
        '(cd b && go test -run "^(TestCallLLMRetries|TestWS)$" -json ./... || echo -)',
      runner: 'go',
      tests: 2,
    });
    expect(narrowToRed('go test ./x', cases, exists, 'linux')).toMatchObject({
      line: "go test -run '^(TestCallLLMRetries|TestWS)$' ./x",
    });
    expect(narrowToRed('go test -run TestX ./x', cases, exists)).toMatchObject({
      reason: expect.stringContaining('-run'),
    });
    expect(
      narrowToRed('go test ./x', [{ key: 'k', file: 'x/', tests: [{ name: '(build)' }] }], exists),
    ).toMatchObject({ reason: expect.stringContaining('сборка') });
  });

  // g9 26.10 (F7): `{go-modules}` строит `go test -C <модуль> …`, а `-run` вставал сразу после
  // `go test` — go отказывал «-C flag must be first flag», и развилка не стартовала ни разу.
  it('go test -C <модуль>: -run встаёт после -C и его каталога, в любой записи каталога', () => {
    const cases = [{ key: 'k', file: 'shared-security/x/', tests: [{ name: 'TestA' }] }];
    const line =
      '(go test -C shared-security -json ./x > "r.json" || echo -) && ' +
      '(go test -C "my mod" -json . >> "r.json" || echo -) && (go test -C=b -json . || echo -)';
    expect(narrowToRed(line, cases, exists, 'win32')).toMatchObject({
      line:
        '(go test -C shared-security -run "^(TestA)$" -json ./x > "r.json" || echo -) && ' +
        '(go test -C "my mod" -run "^(TestA)$" -json . >> "r.json" || echo -) && ' +
        '(go test -C=b -run "^(TestA)$" -json . || echo -)',
      runner: 'go',
    });
  });

  it('vitest: -t после «vitest run», путь node_modules/vitest не тронут, имя — последняя часть', () => {
    const tests = [{ name: 'панель > считает (2+2)', owner: 'src/a.test.ts' }];
    const line = '"C:/p/node_modules/vitest/vitest.mjs" run --root "C:/p/admin" src/a.test.ts';
    expect(
      narrowToRed(line, [{ key: 'k', file: 'src/a.test.ts', tests }], exists, 'win32'),
    ).toEqual({
      line: '"C:/p/node_modules/vitest/vitest.mjs" run -t "считает \\(2\\+2\\)" --root "C:/p/admin" src/a.test.ts',
      runner: 'vitest',
      tests: 1,
    });
  });

  it('раннер без выбора теста (node-скрипт) — кейсы целиком', () => {
    const tests = [{ name: '[pkg-001] value', owner: 'check.mjs' }];
    expect(
      narrowToRed('node check.mjs r.xml', [{ key: 'k', file: 'check.mjs', tests }], exists),
    ).toMatchObject({ reason: expect.stringContaining('не выбирает тесты') });
  });
});
