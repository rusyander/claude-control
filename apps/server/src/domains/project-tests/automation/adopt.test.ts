import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareResultsForRun } from '../import-results/import-results.ts';
import { readGroups } from '../store/store.ts';
import { adoptUnmatched } from './adopt.ts';
import { collectReport } from './report.ts';

/**
 * «Завести кейсы» доказывается кругом, а не полями кейса: отчёт НАСТОЯЩЕГО
 * прогона → без кейса → кейсы → тот же отчёт ложится на них целиком. Кейс,
 * который следующий прогон не находит, хуже, чем никакой.
 */
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

describe('project-tests/automation/adopt: кейсы для тестов без кейса', () => {
  let root = '';
  const put = (path: string, body = ''): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const report = (name: string, format: 'go-test-json' | 'cargo-test'): string => {
    const path = join(root, '.out', name);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(join(FIXTURES, name), path);
    const now = new Date();
    utimesSync(path, now, now);
    return collectReport(path, format, Date.now())?.content ?? '';
  };
  const run = (content: string) =>
    prepareResultsForRun(root, { format: 'junit', content, now: '2026-10-12T10:00:00Z' }, 'r1');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-adopt-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Go: кейс на тест, файл по func, имя с пакетом; второй прогон ложится целиком', () => {
    put('go.mod', 'module example.com/goshop\n');
    put(
      'orders/orders_test.go',
      'package orders\n\nfunc TestTotal(t *testing.T) {}\nfunc TestTotalBroken(t *testing.T) {}\nfunc TestSkipped(t *testing.T) {}\n',
    );
    put('orders/table_test.go', 'package orders\n\nfunc TestTable(t *testing.T) {}\n');
    const content = report('go-test.json', 'go-test-json');
    const first = run(content);
    expect(first.result.matched).toBe(0);

    const adopted = adoptUnmatched(root, first.unmatchedResults, [root], '2026-10-12T10:00:01Z');
    // Шесть тестов: «(build)» сломанного пакета кейсом не становится.
    expect(adopted).toMatchObject({ added: 6, skipped: 1 });
    const cases = readGroups(root).flatMap((group) => group.cases);
    const total = cases.find((item) => item.title === 'TestTotal');
    expect(total?.automation).toEqual({
      status: 'automated',
      testName: 'example.com/goshop/orders.TestTotal',
      file: 'orders/orders_test.go',
    });
    expect(cases.find((item) => item.title === 'TestTable/two')?.automation?.file).toBe(
      'orders/table_test.go',
    );

    const second = run(content);
    expect(second.result.unmatched).toEqual(['(build)']);
    expect(second.result.matched).toBe(6);
    const statuses = Object.fromEntries(
      second.points.map((point) => [
        cases.find((item) => item.id === point.caseId)?.title,
        point.status,
      ]),
    );
    expect(statuses).toMatchObject({
      TestTotal: 'passed',
      TestTotalBroken: 'failed',
      TestSkipped: 'skipped',
      'TestTable/two': 'failed',
    });
  });

  it('Cargo: файл модуля из имени теста, интеграционный — свой файл', () => {
    put('Cargo.toml', '[package]\nname = "rshop"\n');
    put('src/lib.rs', '');
    put('src/orders.rs', '');
    put('tests/api.rs', '');
    const content = report('cargo-test.txt', 'cargo-test');
    const adopted = adoptUnmatched(root, run(content).unmatchedResults, [root], 'now');
    expect(adopted.added).toBe(6);
    const files = Object.fromEntries(
      readGroups(root)
        .flatMap((group) => group.cases)
        .map((item) => [item.title, item.automation?.file]),
    );
    expect(files).toMatchObject({
      'orders::tests::total_broken': 'src/orders.rs',
      'tests::adds': 'src/lib.rs',
      api_works: 'tests/api.rs',
    });
    expect(run(content).result.unmatched).toEqual([]);
  });

  it('JVM и pytest: файл по имени класса и модуля, параметры pytest — один кейс', () => {
    put('api/src/test/java/com/shop/OrderTest.java', '');
    put('tests/test_pay.py', '');
    const junit = `<testsuites>
<testsuite name="com.shop.OrderTest"><testcase classname="com.shop.OrderTest" name="createsOrder()"/></testsuite>
<testsuite name="pytest"><testcase classname="tests.test_pay" name="test_refund[1-2]"/><testcase classname="tests.test_pay" name="test_refund[3-4]"><failure message="boom"/></testcase></testsuite>
</testsuites>`;
    const adopted = adoptUnmatched(
      root,
      run(junit).unmatchedResults,
      [root, join(root, 'api')],
      'now',
    );
    expect(adopted.added).toBe(2);
    const cases = readGroups(root).flatMap((group) => group.cases);
    expect(cases.map((item) => item.automation?.file).sort()).toEqual([
      'api/src/test/java/com/shop/OrderTest.java',
      'tests/test_pay.py',
    ]);
    const again = run(junit);
    expect(again.result.unmatched).toEqual([]);
    // Худший из наборов данных — итог кейса.
    expect(again.points.find((point) => point.status === 'failed')).toBeDefined();
  });

  it('файл не нашёлся — кейс без файла, а не с выдуманным путём; повтор не дублирует', () => {
    const junit =
      '<testsuite name="x"><testcase classname="com.gone.Ghost" name="haunts"/></testsuite>';
    const results = run(junit).unmatchedResults;
    adoptUnmatched(root, results, [root], 'now');
    const [ghost] = readGroups(root).flatMap((group) => group.cases);
    expect(ghost?.automation).toEqual({ status: 'automated', testName: 'com.gone.Ghost.haunts' });
    expect(adoptUnmatched(root, results, [root], 'now')).toMatchObject({ added: 0, skipped: 1 });
  });
});
