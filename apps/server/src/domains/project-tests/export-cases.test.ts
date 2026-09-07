import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildJUnitReport, exportGroup, toCsv, toMarkdown, toXlsx } from './export-cases.ts';
import { importCases, readXlsx } from './import-cases.ts';
import { createGroup, readGroups } from './store.ts';

/**
 * Выгрузка кейсов. Проверяется одно свойство, ради которого она такая, какая
 * есть: ВЫГРУЖЕННОЕ ЧИТАЕТСЯ ОБРАТНО. Таблицу выгружают, правят в Excel и
 * заливают назад — если заголовки или формат шага разъедутся с импортом, эта
 * дорога молча превратится в дублирование кейсов.
 */
const NOW = '2026-09-07T10:00:00.000Z';
const AT = new Date('2026-09-07T10:00:00Z');

const RICH = {
  id: 'gui-001',
  type: 'case',
  title: 'Открытие чата',
  purpose: 'Человек должен увидеть список разговоров',
  area: 'Чат',
  section: 'Чат/Основное',
  precondition: 'Панель открыта',
  steps: [
    { action: 'Нажать «Чат»', expected: 'открылся список' },
    { action: 'Выбрать разговор', data: 'первый в списке' },
  ],
  expected: 'Видна переписка',
  postcondition: 'Вернуться на главную',
  oracle: 'Заголовок разговора на экране',
  priority: 'high',
  readiness: 'ready',
  duration: 5,
  tags: ['smoke', 'чат'],
  links: [{ type: 'requirement', url: 'https://tracker/REQ-1' }],
  automation: { status: 'automated', file: 'e2e/chat.spec.ts', testName: 'открывает чат' },
  codePaths: ['apps/web/src/pages/Chat/ui/ChatPage.tsx'],
  status: 'failed',
  note: 'не открылось',
  source: 'human',
};

function writeGroupFile(root: string, cases: unknown[]): void {
  const dir = join(root, '.agent', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'gui.tests.json'),
    JSON.stringify({ version: 1, title: 'GUI', description: 'Интерфейс', cases }, null, 2),
  );
}

describe('выгрузка кейсов', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-export-'));
    writeGroupFile(root, [RICH]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('CSV начинается с BOM и содержит заголовки, которые понимает импорт', () => {
    const csv = toCsv(readGroups(root)[0]!);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Название');
    expect(csv).toContain('Файл теста');
    // Многострочная ячейка шагов взята в кавычки, иначе строка разъедется.
    expect(csv).toContain('"Нажать «Чат» · ожидание: открылся список');
  });

  it('выгрузка → импорт возвращает кейс тем же по существу', () => {
    const csv = toCsv(readGroups(root)[0]!);
    const copy = mkdtempSync(join(tmpdir(), 'cc-roundtrip-'));
    try {
      createGroup(copy, 'gui');
      const result = importCases(copy, { format: 'csv', groupId: 'gui', content: csv, now: NOW });

      expect(result).toMatchObject({ read: 1, created: 1 });
      expect(readGroups(copy)[0]?.cases[0]).toMatchObject({
        id: 'gui-001',
        title: 'Открытие чата',
        purpose: 'Человек должен увидеть список разговоров',
        area: 'Чат',
        section: 'Чат/Основное',
        precondition: 'Панель открыта',
        steps: [
          { action: 'Нажать «Чат»', expected: 'открылся список' },
          { action: 'Выбрать разговор', data: 'первый в списке' },
        ],
        expected: 'Видна переписка',
        postcondition: 'Вернуться на главную',
        oracle: 'Заголовок разговора на экране',
        priority: 'high',
        readiness: 'ready',
        duration: 5,
        tags: ['smoke', 'чат'],
        automation: { status: 'automated', file: 'e2e/chat.spec.ts', testName: 'открывает чат' },
        codePaths: ['apps/web/src/pages/Chat/ui/ChatPage.tsx'],
        status: 'failed',
      });
    } finally {
      rmSync(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('книга Excel читается обратно как таблица', () => {
    const rows = readXlsx(toXlsx(readGroups(root)[0]!, AT));

    expect(rows[0]?.[1]).toBe('Название');
    expect(rows[1]?.[0]).toBe('gui-001');
    expect(rows[1]?.[2]).toBe('Кейс');
    expect(rows[1]?.[7]).toBe(
      'Нажать «Чат» · ожидание: открылся список\nВыбрать разговор · данные: первый в списке',
    );
  });

  it('книга собрана по OOXML: описи, связи и лист на месте', () => {
    const book = toXlsx(readGroups(root)[0]!, AT).toString('latin1');

    for (const part of [
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]) {
      expect(book).toContain(part);
    }
  });

  it('документ для чтения выводит шаги нумерованным списком', () => {
    const md = toMarkdown(readGroups(root)[0]!);

    expect(md).toContain('# GUI');
    expect(md).toContain('## Чат/Основное');
    expect(md).toContain('### Открытие чата');
    expect(md).toContain('1. Нажать «Чат» · ожидание: открылся список');
    expect(md).toContain('- Автотест: `e2e/chat.spec.ts` (открывает чат)');
  });

  it('архивные кейсы в выгрузку не идут', () => {
    writeGroupFile(root, [RICH, { ...RICH, id: 'gui-002', title: 'Убрано', archived: true }]);

    expect(toCsv(readGroups(root)[0]!)).not.toContain('Убрано');
    expect(toMarkdown(readGroups(root)[0]!)).not.toContain('Убрано');
  });

  it('exportGroup отдаёт имя файла и тип на каждый формат', () => {
    expect(exportGroup(root, 'gui', 'md')).toMatchObject({
      filename: 'gui-tests.md',
      contentType: 'text/markdown; charset=utf-8',
    });
    expect(exportGroup(root, 'gui', 'csv')).toMatchObject({
      filename: 'gui-tests.csv',
      contentType: 'text/csv; charset=utf-8',
    });
    const book = exportGroup(root, 'gui', 'xlsx', AT);
    expect(book.filename).toBe('gui-tests.xlsx');
    expect(book.body.length).toBeGreaterThan(0);
  });

  it('сломанная группа и неизвестный формат — ошибка с причиной, а не пустой файл', () => {
    writeFileSync(join(root, '.agent', 'tests', 'broken.tests.json'), '{ сломано');

    expect(() => exportGroup(root, 'broken', 'csv')).toThrow(/broken/);
    expect(() => exportGroup(root, 'gui', 'pdf' as 'csv')).toThrow(/Неизвестный формат/);
  });

  it('отчёт JUnit: «не гоняли» — пропуск, «заблокирован» — падение', () => {
    writeGroupFile(root, [
      RICH,
      { id: 'gui-002', title: 'Зелёный', steps: [], status: 'passed' },
      { id: 'gui-003', title: 'Не гоняли', steps: [], status: 'unknown' },
      { id: 'gui-004', title: 'Заблокирован', steps: [], status: 'blocked' },
    ]);

    const xml = buildJUnitReport(readGroups(root));

    expect(xml).toContain('tests="4" failures="2" skipped="1"');
    expect(xml).toContain(
      '<testcase name="[gui-001] Открытие чата" classname="gui" time="0"><failure',
    );
    expect(xml).toContain(
      '<testcase name="[gui-003] Не гоняли" classname="gui" time="0"><skipped message="Не гоняли"/>',
    );
    // Зелёный кейс — пустой testcase, без вложений.
    expect(xml).toContain(
      '<testcase name="[gui-002] Зелёный" classname="gui" time="0"></testcase>',
    );
  });

  it('сломанная группа не попадает в отчёт и не роняет его', () => {
    writeFileSync(join(root, '.agent', 'tests', 'broken.tests.json'), '{ сломано');

    const xml = buildJUnitReport(readGroups(root));

    expect(xml).toContain('tests="1"');
    expect(xml).not.toContain('broken');
  });
});
