import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { toXlsx } from './export-cases.ts';
import { importCases, parseCsv, parseRows, readXlsx } from './import-cases.ts';
import { createGroup, readGroups } from './store.ts';

/**
 * Импорт кейсов из таблиц. Главное здесь — что колонки опознаются ПО
 * ЗАГОЛОВКУ на двух языках, а повторный импорт правленой таблицы обновляет
 * кейсы, а не плодит двойники.
 */
const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const NOW = '2026-09-07T10:00:00.000Z';

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function cases(root: string, groupId = 'gui') {
  return readGroups(root).find((group) => group.id === groupId)?.cases ?? [];
}

describe('импорт кейсов', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-cases-'));
    createGroup(root, 'gui');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('разбирает CSV с кавычками, переводом строки внутри ячейки и своим разделителем', () => {
    const rows = parseCsv('a;b;c\n"строка\nв две";"он сказал ""да""";3\n');

    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['строка\nв две', 'он сказал "да"', '3'],
    ]);
  });

  it('запятая и табуляция тоже разделители — выгрузки приходят разные', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('русские заголовки, приоритеты и автоматизация переводятся в поля кейса', () => {
    const rows = parseRows(parseCsv(fixture('cases.csv')));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: 'Открытие чата',
      section: 'Чат',
      priority: 'high',
      readiness: 'ready',
      expected: 'Видна переписка',
      tags: ['smoke', 'чат'],
      automation: { status: 'automated', file: 'e2e/chat.spec.ts', testName: 'открывает чат' },
    });
    // Шаг читается ровно в том виде, в каком его пишет выгрузка.
    expect(rows[0]?.steps).toEqual([
      { action: 'Нажать «Чат»', expected: 'открылся список' },
      { action: 'Выбрать разговор', data: 'первый в списке' },
    ]);
    expect(rows[1]).toMatchObject({ priority: 'blocker', readiness: 'draft' });
  });

  it('строка без названия пропускается, а не заводит безымянный кейс', () => {
    const rows = parseRows(parseCsv(fixture('cases.csv')));

    expect(rows.map((row) => row.title)).toEqual(['Открытие чата', 'Отправка сообщения']);
  });

  it('английские заголовки понимаются так же, как русские', () => {
    const rows = parseRows(
      parseCsv('Title,Section,Priority,Steps,Expected Result\nLogin,Auth,High,"Open page",Shown'),
    );

    expect(rows[0]).toMatchObject({
      title: 'Login',
      section: 'Auth',
      priority: 'high',
      expected: 'Shown',
      steps: [{ action: 'Open page' }],
    });
  });

  it('разложенные по колонкам шаги TestRail собираются в список по порядку', () => {
    const rows = parseRows(parseCsv(fixture('testrail-export.csv')));

    expect(rows[0]?.steps).toEqual([
      { action: 'Нажать «Чат»', expected: 'Открылся список разговоров' },
      { action: 'Выбрать разговор', expected: 'Показана переписка' },
    ]);
    // Пустая вторая пара колонок не даёт пустого шага.
    expect(rows[2]?.steps).toHaveLength(1);
  });

  it('кладёт кейсы в группу и помечает их человеческими', () => {
    const result = importCases(root, {
      format: 'csv',
      groupId: 'gui',
      content: fixture('cases.csv'),
      now: NOW,
    });

    expect(result).toMatchObject({ format: 'csv', read: 2, created: 2, matched: 0 });
    const list = cases(root);
    expect(list.map((item) => item.id)).toEqual(['gui-001', 'gui-002']);
    // Агенту запрещено удалять человеческие кейсы — иначе он снесёт перенос.
    expect(list.every((item) => item.source === 'human')).toBe(true);
    expect(list[0]?.status).toBe('unknown');
  });

  it('повторный импорт правленой таблицы ОБНОВЛЯЕТ кейс, а не двоит его', () => {
    importCases(root, { format: 'csv', groupId: 'gui', content: fixture('cases.csv'), now: NOW });
    const second = importCases(root, {
      format: 'csv',
      groupId: 'gui',
      content: 'Название;Ожидание\nОткрытие чата;Стало другое ожидание',
      now: NOW,
    });

    expect(second).toMatchObject({ read: 1, matched: 1, created: 0 });
    const list = cases(root);
    expect(list).toHaveLength(2);
    expect(list[0]?.expected).toBe('Стало другое ожидание');
  });

  it('обновление таблицей не затирает результат прогона', () => {
    importCases(root, { format: 'csv', groupId: 'gui', content: fixture('cases.csv'), now: NOW });
    const path = join(root, '.agent', 'tests', 'gui.tests.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      cases: { status: string; note?: string; lastRunId?: string }[];
    };
    data.cases[0]!.status = 'failed';
    data.cases[0]!.note = 'упало вчера';
    data.cases[0]!.lastRunId = 'run-1';
    writeFileSync(path, JSON.stringify(data, null, 2));

    importCases(root, {
      format: 'csv',
      groupId: 'gui',
      content: 'Название;Цель\nОткрытие чата;Новая цель',
      now: NOW,
    });

    // Таблица описывает кейс, а не его результат: описание обновилось, след
    // прогона остался. Иначе первый же импорт стирал бы вчерашнее красное.
    expect(cases(root)[0]).toMatchObject({
      purpose: 'Новая цель',
      status: 'failed',
      note: 'упало вчера',
      lastRunId: 'run-1',
    });
  });

  it('таблица без узнаваемых заголовков — понятная ошибка, а не пустой импорт', () => {
    expect(() =>
      importCases(root, { format: 'csv', groupId: 'gui', content: 'нечто;иное\n1;2' }),
    ).toThrow(/Название/);
  });

  it('книга Excel читается обратно тем же составом, каким её выгрузили', () => {
    importCases(root, { format: 'csv', groupId: 'gui', content: fixture('cases.csv'), now: NOW });
    const group = readGroups(root)[0]!;
    const book = toXlsx(group, new Date('2026-09-07T10:00:00Z'));

    const rows = readXlsx(book);
    expect(rows[0]).toContain('Название');
    expect(rows[1]?.[1]).toBe('Открытие чата');
    // Многострочная ячейка шагов переживает книгу.
    expect(rows[1]?.[7]).toContain('\n');
  });

  it('книга принимается base64 и заводит кейсы', () => {
    importCases(root, { format: 'csv', groupId: 'gui', content: fixture('cases.csv'), now: NOW });
    const book = toXlsx(readGroups(root)[0]!, new Date('2026-09-07T10:00:00Z'));
    createGroup(root, 'copy');

    const result = importCases(root, {
      format: 'xlsx',
      groupId: 'copy',
      content: book.toString('base64'),
      now: NOW,
    });

    expect(result).toMatchObject({ format: 'xlsx', read: 2, created: 2 });
    expect(cases(root, 'copy').map((item) => item.title)).toEqual([
      'Открытие чата',
      'Отправка сообщения',
    ]);
  });

  it('не книга и пустое тело — ошибка с причиной', () => {
    expect(() =>
      importCases(root, {
        format: 'xlsx',
        groupId: 'gui',
        content: Buffer.from('нет').toString('base64'),
      }),
    ).toThrow(/книга Excel/);
    expect(() => importCases(root, { format: 'csv', groupId: 'gui' })).toThrow(
      /Нечего импортировать/,
    );
  });
});
