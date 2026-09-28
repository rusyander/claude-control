import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReport } from './runs-store.ts';
import { createGroup, readGroups, upsertCase } from './store.ts';

/**
 * Живой обход 28.09: в английской панели «Покрытие по зонам» показывало строку
 * «без зоны» — сервер клал русское слово ключом зоны, и перевод экрана
 * (`tests.report.areaNone`, срабатывает на пустой ключ) не включался никогда.
 * Кейс без зоны — пустой ключ; слово подставляет экран на языке панели.
 */
describe('project-tests/runs-store: кейс без зоны', () => {
  let project = '';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'cc-area-none-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('зона кейса без поля — пустой ключ, без слова какого-либо языка', () => {
    createGroup(project, 'gui');
    upsertCase(project, 'gui', { title: 'Без зоны', steps: ['a'] }, '2026-09-01T00:00:00.000Z');
    upsertCase(
      project,
      'gui',
      { title: 'С зоной', steps: ['a'], area: 'auth' },
      '2026-09-01T00:00:00.000Z',
    );

    const report = buildReport(project, readGroups(project));

    expect(report.areas.map((row) => row.area).sort()).toEqual(['', 'auth']);
  });
});
