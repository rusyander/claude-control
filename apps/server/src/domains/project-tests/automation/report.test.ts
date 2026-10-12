import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJUnit } from '../import-results/import-results.ts';
import { clearReport, collectReport, reportTail } from './report.ts';

/**
 * Отчёт своей команды: файл, каталог Gradle/Maven, родной вывод Go и Cargo.
 * Вывод в `__fixtures__` снят с НАСТОЯЩИХ `go test -json` (go 1.27) и
 * `cargo test` (cargo 1.98) на маленьких проектах: зелёный, красный,
 * пропущенный, подтесты, интеграционный и doc-тест, сломанная сборка.
 */
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));

describe('project-tests/automation/report: отчёт своей команды', () => {
  let dir = '';
  const started = Date.now();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-report-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const fixture = (name: string): string => {
    const path = join(dir, name);
    copyFileSync(join(FIXTURES, name), path);
    // Копия на Windows хранит время оригинала — а отчёт обязан быть «этого прогона».
    const now = new Date();
    utimesSync(path, now, now);
    return path;
  };

  it('go test -json: статусы, подтесты, суть падения и упавшая сборка пакета', () => {
    const collected = collectReport(fixture('go-test.json'), 'go-test-json', started);
    const results = parseJUnit(collected?.content ?? '');
    const by = (name: string) => results.find((item) => item.name === name);

    expect(by('TestTotal')).toMatchObject({ status: 'passed', owner: 'example.com/goshop/orders' });
    expect(by('TestSkipped')?.status).toBe('skipped');
    expect(by('TestTable/one')?.status).toBe('passed');
    expect(by('TestTable/two')?.status).toBe('failed');
    // Суть — строка t.Errorf, а не t.Logf перед ней и не служебное «=== RUN».
    expect(by('TestTotalBroken')).toMatchObject({ status: 'failed' });
    expect(by('TestTotalBroken')?.message).toContain('want 5 & <ok>');
    expect(by('TestTotalBroken')?.message).not.toContain('=== RUN');
    // Пакет, не собравшийся до тестов, — один красный результат с ошибкой компилятора.
    const build = results.find(
      (item) => item.name === '(build)' && item.owner === 'example.com/goshop/broken',
    );
    expect(build?.status).toBe('failed');
    expect(build?.message).toContain('cannot use "x"');
    // У пакета с красными тестами своего «(build)» нет: он не сборка.
    expect(
      results.some((item) => item.name === '(build)' && item.owner === 'example.com/goshop/orders'),
    ).toBe(false);
  });

  it('cargo test: файл набора — classname через /, ignored — пропуск, суть — текст assert', () => {
    const collected = collectReport(fixture('cargo-test.txt'), 'cargo-test', started);
    const results = parseJUnit(collected?.content ?? '');
    const by = (name: string) => results.find((item) => item.name === name);

    expect(by('tests::adds')).toMatchObject({ status: 'passed', owner: 'src/lib.rs' });
    expect(by('tests::slow')?.status).toBe('skipped');
    expect(by('api_works')).toMatchObject({ status: 'passed', owner: 'tests/api.rs' });
    expect(by('orders::tests::total_broken')?.status).toBe('failed');
    // Суть — первой строкой и это строка assert'а, а не место паники: вывод идёт следом.
    expect(by('orders::tests::total_broken')?.message?.split('\n')[0]).toBe(
      'assertion `left == right` failed: want five',
    );
    expect(results.some((item) => item.owner === 'doc-tests rshop')).toBe(true);
    // «error: test failed, to rerun» — итог красных тестов, а не упавшая сборка.
    expect(results.some((item) => item.name === '(build)')).toBe(false);
    expect(results).toHaveLength(6);
  });

  it('cargo test со сломанной сборкой — красный «(build)» с ошибкой компилятора', () => {
    const collected = collectReport(fixture('cargo-broken.txt'), 'cargo-test', started);
    const results = parseJUnit(collected?.content ?? '');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: '(build)', status: 'failed' });
    expect(results[0]?.message).toContain('error[E0277]');
  });

  it('файл от «не является командой» — отчёта нет, а его хвост виден', () => {
    const path = join(dir, 'out.txt');
    writeFileSync(path, "'cargo' is not recognized as an internal or external command\r\n");
    expect(collectReport(path, 'cargo-test', started)).toBeUndefined();
    expect(reportTail(path)).toContain('is not recognized');
    writeFileSync(path, '');
    expect(collectReport(path, 'go-test-json', started)).toBeUndefined();
  });

  it('каталог: сведены только свежие *.xml, вчерашний отчёт и не-xml — мимо', () => {
    const reports = join(dir, 'surefire-reports');
    mkdirSync(reports);
    const suite = (name: string) =>
      `<?xml version="1.0"?><testsuite name="${name}"><testcase classname="com.shop.${name}" name="works"/></testsuite>`;
    writeFileSync(join(reports, 'TEST-com.shop.Old.xml'), suite('Old'));
    const yesterday = new Date(started - 86_400_000);
    utimesSync(join(reports, 'TEST-com.shop.Old.xml'), yesterday, yesterday);
    writeFileSync(join(reports, 'TEST-com.shop.Order.xml'), suite('Order'));
    writeFileSync(
      join(reports, 'TEST-com.shop.Pay.xml'),
      `<testsuites>${suite('Pay').replace(/<\?xml[^>]*\?>/, '')}</testsuites>`,
    );
    writeFileSync(join(reports, 'com.shop.Order.txt'), 'plain summary');

    const collected = collectReport(`${reports}/`, 'junit', started);
    expect(collected?.files).toBe(2);
    const owners = parseJUnit(collected?.content ?? '').map((item) => item.owner);
    expect(owners.sort()).toEqual(['com.shop.Order', 'com.shop.Pay']);
  });

  it('каталог без свежих отчётов и пропавший каталог — отчёта нет', () => {
    const reports = join(dir, 'test-results');
    mkdirSync(reports);
    const old = join(reports, 'TEST-a.xml');
    writeFileSync(old, '<testsuite><testcase name="a"/></testsuite>');
    const yesterday = new Date(started - 86_400_000);
    utimesSync(old, yesterday, yesterday);
    expect(collectReport(`${reports}/`, 'junit', started)).toBeUndefined();
    expect(collectReport(`${join(dir, 'nope')}/`, 'junit', started)).toBeUndefined();
  });

  it('перед прогоном: файл стирается, каталог — нет', () => {
    const file = join(dir, 'deep', 'junit.xml');
    mkdirSync(join(dir, 'deep'));
    writeFileSync(file, '<testsuite/>');
    clearReport(file);
    expect(existsSync(file)).toBe(false);

    const reports = join(dir, 'reports');
    mkdirSync(reports);
    writeFileSync(join(reports, 'TEST-keep.xml'), '<testsuite/>');
    clearReport(`${reports}/`);
    expect(existsSync(join(reports, 'TEST-keep.xml'))).toBe(true);
  });
});
