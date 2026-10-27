import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importResults } from './import-results.ts';
import { readGroups } from '../store/store.ts';

/**
 * testName кейса — путь describe: им покрыт каждый тест под ним (g9 27.10: кейс
 * `getLockReason` остался «без результата», хотя оба его теста прошли).
 */
const NOW = '2026-10-27T00:00:00.000Z';

function automated(id: string, file: string, testName: string) {
  return {
    id,
    title: id,
    steps: [],
    automation: { status: 'automated', file, testName },
    status: 'unknown',
  };
}

function junit(tests: [file: string, name: string, failed?: boolean][]): string {
  const cases = tests
    .map(
      ([file, name, failed]) =>
        `<testcase classname="${file}" name="${name.replace(/>/g, '&gt;')}" time="0.01">${
          failed ? '<failure message="boom"/>' : ''
        }</testcase>`,
    )
    .join('');
  return `<testsuites><testsuite name="all">${cases}</testsuite></testsuites>`;
}

describe('импорт результатов: testName кейса — путь describe', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-import-describe-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function cases(list: unknown[]): void {
    const dir = join(root, '.agent', 'tests');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ui.tests.json'),
      JSON.stringify({ version: 1, title: 'UI', cases: list }, null, 2),
    );
  }

  function status(id: string): string | undefined {
    return readGroups(root)[0]?.cases.find((item) => item.id === id)?.status;
  }

  it('тесты под describe ложатся на кейс, худший — его статус', () => {
    cases([automated('ui-001', 'apps/web/src/a.test.tsx', 'getLockReason')]);
    const green = importResults(root, {
      format: 'junit',
      content: junit([
        ['src/a.test.tsx', 'getLockReason > склеивает зависимые права'],
        ['src/a.test.tsx', 'getLockReason > называет одно право'],
      ]),
      now: NOW,
    });
    expect(green).toMatchObject({ matched: 1, unmatched: [] });
    expect(status('ui-001')).toBe('passed');

    importResults(root, {
      format: 'junit',
      content: junit([
        ['src/a.test.tsx', 'getLockReason > склеивает зависимые права'],
        ['src/a.test.tsx', 'getLockReason > называет одно право', true],
      ]),
      now: NOW,
    });
    expect(status('ui-001')).toBe('failed');
  });

  it('тот же describe в чужом файле кейс не трогает', () => {
    cases([automated('ui-001', 'src/a.test.tsx', 'getLockReason')]);
    const result = importResults(root, {
      format: 'junit',
      content: junit([['src/b.test.tsx', 'getLockReason > чужой тест', true]]),
      now: NOW,
    });
    expect(result.unmatched).toEqual(['getLockReason > чужой тест']);
    expect(status('ui-001')).toBe('unknown');
  });

  it('вложенный путь сильнее внешнего, а имя, лишь начинающееся с пути, — не под ним', () => {
    // Вложенный первым: короткий путь после длинного не должен его перебить.
    cases([
      automated('ui-002', 'src/a.test.tsx', 'outer > inner'),
      automated('ui-001', 'src/a.test.tsx', 'outer'),
    ]);
    const result = importResults(root, {
      format: 'junit',
      content: junit([
        ['src/a.test.tsx', 'outer > inner > падает', true],
        ['src/a.test.tsx', 'outer > снаружи'],
        ['src/a.test.tsx', 'outerwear > другой describe', true],
      ]),
      now: NOW,
    });
    expect(status('ui-002')).toBe('failed');
    expect(status('ui-001')).toBe('passed');
    expect(result.unmatched).toEqual(['outerwear > другой describe']);
  });

  it('два кейса на один путь в одном файле — догадка, результат без кейса', () => {
    cases([
      automated('ui-001', 'src/a.test.tsx', 'shared'),
      automated('ui-002', 'src/a.test.tsx', 'shared'),
    ]);
    const result = importResults(root, {
      format: 'junit',
      content: junit([['src/a.test.tsx', 'shared > тест']]),
      now: NOW,
    });
    expect(result.unmatched).toEqual(['shared > тест']);
  });
});
