import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { importResults, parseAllure, parseJUnit, parsePlaywrightJson } from './import-results.ts';
import { readGroups } from './store.ts';

/**
 * Импорт результатов из CI. Проверяется то, ради чего он написан: чужой отчёт
 * ложится на НАШИ кейсы по трём правилам сопоставления, а то, что не сошлось,
 * возвращается списком, а не красит случайный кейс.
 */
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const NOW = '2026-09-07T10:00:00.000Z';

/** Кейсы тестового проекта: по одному под каждое правило сопоставления. */
const CASES = [
  {
    id: 'gui-001',
    title: 'Открытие чата',
    steps: ['нажать'],
    automation: { status: 'automated', file: 'e2e/chat.spec.ts', testName: 'открывает чат' },
    status: 'unknown',
  },
  { id: 'gui-002', title: 'Отправка сообщения', steps: [], status: 'passed' },
  { id: 'gui-003', title: 'Загрузка вложения', steps: [], status: 'unknown' },
  {
    id: 'gui-004',
    title: 'Здоровье API',
    steps: [],
    automation: { status: 'automated', file: 'api.spec.ts', testName: 'health' },
    status: 'passed',
  },
];

function writeCases(root: string, cases: unknown[] = CASES): void {
  const dir = join(root, '.agent', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gui.tests.json'),
    JSON.stringify({ version: 1, title: 'GUI', cases }, null, 2),
  );
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function statuses(root: string): Record<string, string> {
  const [group] = readGroups(root);
  const result: Record<string, string> = {};
  for (const item of group?.cases ?? []) result[item.id] = item.status;
  return result;
}

describe('импорт результатов', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-import-'));
    writeCases(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('разбирает JUnit: падение, ошибка, пропуск и время', () => {
    const parsed = parseJUnit(fixture('junit-results.xml'));

    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toMatchObject({ name: 'открывает чат', status: 'passed', durationMs: 512 });
    expect(parsed[1]?.status).toBe('failed');
    // Сообщение приходит из атрибута и уже без экранирования.
    expect(parsed[1]?.message).toContain('expected "ок"');
    expect(parsed[2]).toMatchObject({ status: 'skipped', message: 'нет тестовых данных' });
    // `<error>` — тоже падение: для кейса разницы между ним и `<failure>` нет.
    expect(parsed[4]).toMatchObject({ name: 'health', status: 'failed' });
  });

  it('JUnit ложится на кейсы по имени теста, маркеру и названию', () => {
    const result = importResults(root, {
      format: 'junit',
      content: fixture('junit-results.xml'),
      now: NOW,
    });

    expect(result).toMatchObject({ format: 'junit', read: 5, matched: 4, created: 0 });
    expect(statuses(root)).toEqual({
      // по automation.testName
      'gui-001': 'passed',
      // по маркеру [gui-002] внутри имени теста
      'gui-002': 'failed',
      // по точному совпадению названия
      'gui-003': 'skipped',
      // <error> — падение
      'gui-004': 'failed',
    });
    // Чужое имя не красит ничей кейс, а возвращается человеку.
    expect(result.unmatched).toEqual(['никому не известный тест']);
  });

  it('пишет запись прогона import/ci и ссылается на неё из кейса', () => {
    const result = importResults(root, {
      format: 'junit',
      content: fixture('junit-results.xml'),
      environmentId: 'stand',
      now: NOW,
    });

    const runs = readdirSync(join(root, '.agent', 'tests', 'runs'));
    expect(runs).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(root, '.agent', 'tests', 'runs', runs[0]!), 'utf8'),
    );

    expect(record).toMatchObject({
      id: result.runId,
      mode: 'import',
      actor: 'ci',
      origin: 'ci',
      status: 'done',
      environmentId: 'stand',
      summary: { total: 4, passed: 1, failed: 2, skipped: 1, blocked: 0 },
    });
    expect(record.results).toHaveLength(4);

    const [group] = readGroups(root);
    const failed = group?.cases.find((item) => item.id === 'gui-002');
    expect(failed?.lastRunId).toBe(result.runId);
    expect(failed?.lastRunAt).toBe(NOW);
    expect(failed?.note).toContain('expected');
  });

  it('запись прогона не удалась — кейсы не получают ссылку на несуществующий прогон', () => {
    // Сбой ввода-вывода на границе: на месте каталога прогонов лежит файл.
    writeFileSync(join(root, '.agent', 'tests', 'runs'), 'not a directory');
    expect(() =>
      importResults(root, { format: 'junit', content: fixture('junit-results.xml'), now: NOW }),
    ).toThrow();
    const [group] = readGroups(root);
    expect(group?.cases.map((item) => item.lastRunId ?? null)).toEqual([null, null, null, null]);
    expect(statuses(root)).toEqual({
      'gui-001': 'unknown',
      'gui-002': 'passed',
      'gui-003': 'unknown',
      'gui-004': 'passed',
    });
  });

  it('разбирает JSON Playwright: вложенные сюиты, повторы и нестабильность', () => {
    const parsed = parsePlaywrightJson(fixture('playwright-results.json'));

    expect(parsed.map((item) => item.status)).toEqual(['passed', 'failed', 'passed', 'skipped']);
    // Нестабильный в итоге зелёный; признак — число, а не фраза в заметке
    // (F-355): слова к нему берёт словарь стороны.
    expect(parsed[2]?.message).toBeUndefined();
    // Упавшая попытка перед зелёной — числом: по нему карантин судит о повторах.
    expect(parsed[2]?.flakyAttempts).toBe(1);
    expect(parsed[0]?.flakyAttempts).toBeUndefined();
    expect(parsed[1]?.flakyAttempts).toBeUndefined();
    // Длительность — сумма попыток.
    expect(parsed[2]?.durationMs).toBe(550);
    expect(parsed[1]?.aliases).toContain('Чат › отправляет сообщение');
  });

  /**
   * junit Playwright с `includeRetries`: упавшие попытки зелёного теста —
   * `<flakyFailure>`/`<flakyError>`, повторы красного — `<rerunFailure>`. Красный
   * на всех попытках — не «на повторе»: он просто красный.
   */
  it('JUnit с повторами: зелёный на повторе считается, красный с повторами — нет', () => {
    const parsed = parseJUnit(
      '<testsuites><testsuite name="a.spec.ts">' +
        '<testcase name="спасён" classname="a.spec.ts" time="1">' +
        '<flakyFailure message="m1" type="FAILURE"><stackTrace>s</stackTrace></flakyFailure>' +
        '<flakyError message="m2" type="Error"><stackTrace>s</stackTrace></flakyError>' +
        '<flakyFailure message="m3" type="FAILURE"/>' +
        '</testcase>' +
        '<testcase name="красный" classname="a.spec.ts" time="1">' +
        '<failure message="сломан"/>' +
        '<rerunFailure message="снова" type="FAILURE"><stackTrace>s</stackTrace></rerunFailure>' +
        '</testcase>' +
        '<testcase name="зелёный" classname="a.spec.ts" time="1"/>' +
        '</testsuite></testsuites>',
    );

    expect(parsed.map((item) => [item.name, item.status, item.flakyAttempts])).toEqual([
      ['спасён', 'passed', 3],
      ['красный', 'failed', undefined],
      ['зелёный', 'passed', undefined],
    ]);
    expect(parsed[0]?.message).toBeUndefined();
    // Причина красного — его собственный провал, а не текст повтора.
    expect(parsed[1]?.message).toBe('сломан');
  });

  /**
   * Аудит: заметка красного кейса была одним заголовком Playwright — «…failed»,
   * а ожидание и полученное лежат в теле `<failure>` (с цветом терминала).
   */
  it('JUnit Playwright: в заметке провала — ожидание и полученное из тела, без цвета', () => {
    const body = [
      '  [chromium] › auth.spec.ts:9:7 › Вход › [auth-002] неверный пароль',
      '',
      '    Error: \u001b[2mexpect(\u001b[22m\u001b[31mlocator\u001b[39m\u001b[2m).\u001b[22mtoHaveText failed',
      '',
      "    Locator: getByRole('alert')",
      '    Expected: \u001b[32m"Неверный пароль"\u001b[39m',
      '    Received: \u001b[31m"Добро пожаловать"\u001b[39m',
    ].join('\n');
    const [parsed] = parseJUnit(
      '<testsuites><testsuite name="auth.spec.ts">' +
        '<testcase name="Вход › [auth-002] неверный пароль" classname="auth.spec.ts" time="1">' +
        `<failure message="auth.spec.ts:9:7 [auth-002] неверный пароль" type="FAILURE"><![CDATA[${body}]]></failure>` +
        '</testcase></testsuite></testsuites>',
    );
    expect(parsed?.status).toBe('failed');
    expect(parsed?.message).toContain('auth.spec.ts:9:7 [auth-002] неверный пароль');
    expect(parsed?.message).toContain('Expected: "Неверный пароль"');
    expect(parsed?.message).toContain('Received: "Добро пожаловать"');
    expect(parsed?.message).not.toContain('\u001b');
  });

  it('Playwright ставит статусы, а лишний тест уходит в unmatched', () => {
    const result = importResults(root, {
      format: 'playwright',
      content: fixture('playwright-results.json'),
      now: NOW,
    });

    expect(result.read).toBe(4);
    expect(statuses(root)).toMatchObject({
      // по automation.testName
      'gui-001': 'passed',
      // по маркеру [gui-003] — нестабильный в итоге зелёный
      'gui-003': 'passed',
      // «отправляет сообщение» не совпало ни с чем: кейс остался как был
      'gui-002': 'passed',
    });
    expect(result.unmatched).toEqual(['отправляет сообщение', 'никому не известный тест']);
  });

  it('читает каталог Allure по файлам *-result.json', () => {
    const dir = join(root, 'allure-results');
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(join(FIXTURES, 'allure-results'))) {
      writeFileSync(join(dir, name), readFileSync(join(FIXTURES, 'allure-results', name)));
    }

    const result = importResults(root, { format: 'allure', file: 'allure-results', now: NOW });

    expect(result.read).toBe(2);
    // `broken` — это падение: словарь статусов общий для всех клиентов.
    expect(statuses(root)).toMatchObject({ 'gui-001': 'passed', 'gui-002': 'failed' });
  });

  it('несколько результатов на один кейс дают ХУДШИЙ статус', () => {
    const xml =
      '<testsuites><testsuite name="s">' +
      '<testcase classname="c" name="открывает чат" time="0.1"/>' +
      '<testcase classname="c" name="открывает чат" time="0.1"><failure message="упало"/></testcase>' +
      '</testsuite></testsuites>';

    const result = importResults(root, { format: 'junit', content: xml, now: NOW });

    expect(result.read).toBe(2);
    expect(result.matched).toBe(1);
    expect(statuses(root)['gui-001']).toBe('failed');
  });

  it('явная метка [id] сильнее имени теста: общий файл двух кейсов не путает их', () => {
    // g-001 привязан к файлу целиком (testName = файл), g-002 — тот же файл.
    // Раннер пишет classname = файл: без приоритета метки провал g-002 ложился на g-001.
    writeCases(root, [
      {
        id: 'g-001',
        title: 'Проверка целиком',
        steps: [],
        automation: {
          status: 'automated',
          file: 'tools/qa/check.mjs',
          testName: 'tools/qa/check.mjs',
        },
        status: 'passed',
      },
      {
        id: 'g-002',
        title: 'Вторая проверка того же файла',
        steps: [],
        automation: { status: 'automated', file: 'tools/qa/check.mjs' },
        status: 'passed',
      },
    ]);
    const xml =
      '<testsuites><testsuite name="s">' +
      '<testcase classname="tools/qa/check.mjs" name="[g-002] tools/qa/check.mjs" time="1">' +
      '<failure message="упало"/></testcase>' +
      '</testsuite></testsuites>';

    const result = importResults(root, { format: 'junit', content: xml, now: NOW });

    expect(result.matched).toBe(1);
    expect(statuses(root)).toEqual({ 'g-001': 'passed', 'g-002': 'failed' });
  });

  it('хвост параметров pytest `[1]` не метка: точное имя теста сильнее кейса с id «1» (F-135)', () => {
    // id из CSV/TestRail бывают числами, pytest пишет набор данных как `test_x[1]`.
    writeCases(root, [
      { id: '1', title: 'Ручная проверка', steps: [], status: 'unknown' },
      {
        id: 'checkout-001',
        title: 'Количество в корзине',
        steps: [],
        automation: {
          status: 'automated',
          file: 'tests/e2e/test_checkout.py',
          testName: 'tests.e2e.test_checkout.test_quantity',
        },
        status: 'unknown',
      },
    ]);
    const xml =
      '<testsuites><testsuite name="pytest">' +
      '<testcase classname="tests.e2e.test_checkout" name="test_quantity[1]" time="1">' +
      '<failure message="упало"/></testcase>' +
      '</testsuite></testsuites>';

    const result = importResults(root, { format: 'junit', content: xml, now: NOW });

    expect(result.matched).toBe(1);
    expect(statuses(root)).toEqual({ '1': 'unknown', 'checkout-001': 'failed' });
  });

  it('пустой отчёт не трогает статусы и не выдумывает совпадений', () => {
    const result = importResults(root, {
      format: 'junit',
      content: '<testsuites></testsuites>',
      now: NOW,
    });

    expect(result).toMatchObject({ read: 0, matched: 0, unmatched: [] });
    expect(statuses(root)).toMatchObject({ 'gui-002': 'passed', 'gui-004': 'passed' });
  });

  it('сломанная группа не мешает импорту в остальные', () => {
    writeFileSync(join(root, '.agent', 'tests', 'broken.tests.json'), '{ это не json');

    const result = importResults(root, {
      format: 'junit',
      content: fixture('junit-results.xml'),
      now: NOW,
    });

    expect(result.matched).toBe(4);
    expect(readFileSync(join(root, '.agent', 'tests', 'broken.tests.json'), 'utf8')).toBe(
      '{ это не json',
    );
  });

  it('битый JSON и отсутствующий файл — внятная ошибка, а не падение маршрута', () => {
    expect(() => importResults(root, { format: 'playwright', content: '{ сломано' })).toThrow(
      /не разобрался/,
    );
    expect(() => importResults(root, { format: 'junit', file: 'нет-такого.xml' })).toThrow(
      /не найден/,
    );
    expect(() => importResults(root, { format: 'junit' })).toThrow(/Нечего импортировать/);
    // Выход за каталог проекта запрещён так же, как в файлах проекта.
    expect(() => importResults(root, { format: 'junit', file: '../../etc/passwd' })).toThrow();
  });

  it('Allure принимает и одиночную запись, и массив', () => {
    const single = parseAllure(['{"name":"один","status":"failed"}']);
    const many = parseAllure(['[{"name":"a","status":"passed"},{"name":"b","status":"skipped"}]']);

    expect(single).toHaveLength(1);
    expect(single[0]?.status).toBe('failed');
    expect(many.map((item) => item.status)).toEqual(['passed', 'skipped']);
  });
});

describe('импорт результатов: ключи id и allure_id', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-import-ids-'));
    writeCases(root, [
      {
        id: 'gui-001',
        title: 'Открытие чата',
        steps: [],
        automation: { status: 'automated', file: 'e2e/chat.spec.ts', externalId: 'TC-77' },
        status: 'unknown',
      },
    ]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('свойство junit «id» ложится на externalId — так помечают тесты pytest и Allure', () => {
    const xml =
      '<testsuites><testsuite name="s"><testcase classname="c" name="что угодно">' +
      '<properties><property name="id" value="TC-77"/></properties>' +
      '<failure message="упало"/></testcase></testsuite></testsuites>';

    const result = importResults(root, { format: 'junit', content: xml, now: NOW });

    expect(result.matched).toBe(1);
    expect(statuses(root)['gui-001']).toBe('failed');
  });

  it('метка allure_id тоже ключ', () => {
    const result = importResults(root, {
      format: 'allure',
      content: JSON.stringify({
        name: 'иначе названный',
        status: 'passed',
        labels: [{ name: 'allure_id', value: 'TC-77' }],
      }),
      now: NOW,
    });

    expect(result.matched).toBe(1);
    expect(statuses(root)['gui-001']).toBe('passed');
  });
});
