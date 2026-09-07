import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRun, exportRunPdf } from './export-run.ts';
import { writeRun } from './runs-store.ts';
import { createGroup, upsertCase } from './store.ts';

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

    expect(file.filename).toBe('run-202609071000.md');
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

  it('csv отдаёт строку на проход с заголовком кейса и BOM для Excel', () => {
    const text = exportRun(project, 'run-1', 'csv').body.toString('utf8');

    expect(text.startsWith('﻿')).toBe(true);
    expect(text).toContain('Пустой ввод не отправляется');
    expect(text).toContain('провален');
    expect(text.trim().split('\r\n')).toHaveLength(3);
  });

  it('html — готовая к печати страница без единой внешней загрузки', () => {
    const file = exportRun(project, 'run-1', 'html');
    const text = file.body.toString('utf8');

    expect(file.filename).toBe('run-202609071000.html');
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
});
