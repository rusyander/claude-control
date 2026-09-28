import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestReleaseDocument, ProjectTestRunRecord } from '@agentdeck/contracts';
import { writeRun } from '../../domains/project-tests/runs-store.ts';
import { createGroup, upsertCase } from '../../domains/project-tests/store.ts';
import type { TestsDeps } from './shared.ts';
import { registerTestReleaseRoutes } from './release-routes.ts';

/**
 * F-157. Карточка вехи показывает заметку кейса как есть, а заметка без текста
 * человека собирается из провала по шагу — с обвязкой «шаг N: … (ожидалось: …)».
 * В английской панели обвязка была русской: язык экрана брался по умолчанию.
 */
function dropTemp(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Каталог остаётся в temp — на результат теста это не влияет.
  }
}

const failed = (caseId: string): ProjectTestRunRecord => ({
  id: 'aaaaaaaa',
  mode: 'run',
  actor: 'human',
  status: 'done',
  release: '1.4',
  startedAt: '2026-09-01T10:00:00.000Z',
  results: [
    {
      pointId: `gui:${caseId}`,
      groupId: 'gui',
      caseId,
      status: 'failed',
      failure: { step: 2, actual: 'button missing', expected: 'button shown' },
    },
  ],
  summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
});

describe('project-tests release routes: заметка на языке панели', () => {
  let project = '';
  let appData = '';
  let language: string | undefined;
  let app: FastifyInstance;

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-release-'));
    appData = mkdtempSync(join(tmpdir(), 'cc-tests-release-app-'));
    createGroup(project, 'gui');
    const created = upsertCase(
      project,
      'gui',
      { title: 'Save', steps: ['a', 'b'] },
      '2026-09-01T00:00:00.000Z',
    );
    writeRun(project, failed(created.id));
    app = Fastify();
    registerTestReleaseRoutes(app, {
      ctx: {
        store: {
          getSettings: () => ({ language, integrations: { atlassian: { enabled: false } } }),
        },
        location: { paths: { appData } },
      },
    } as unknown as TestsDeps);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dropTemp(project);
    dropTemp(appData);
  });

  it.each([
    ['en', 'step 2: button missing (expected: button shown)'],
    ['ru', 'шаг 2: button missing (ожидалось: button shown)'],
  ])('панель %s — «%s»', async (lang, note) => {
    language = lang;
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/release',
      query: { path: project, release: '1.4' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { document } = response.json<{ document: ProjectTestReleaseDocument }>();
    expect(document.red.map((item) => item.note)).toEqual([note]);
  });

  // Файл и печать вехи — на языке панели того, кто выгружает, как отчёт по
  // прогону. Раньше документ был русским при английском интерфейсе.
  it.each([
    ['en', '# Milestone readiness “1.4”', 'Atlassian is not connected'],
    ['ru', '# Готовность вехи «1.4»', 'Atlassian не подключён'],
  ])('выгрузка вехи, панель %s — «%s»', async (lang, heading, warning) => {
    language = lang;
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/release/export',
      query: { path: project, release: '1.4', format: 'md' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(heading);
    expect(response.body).toContain(warning);
    if (lang === 'en') {
      expect(response.body).toContain(
        '- Save — failed — step 2: button missing (expected: button shown)',
      );
      expect(response.body.match(/[А-Яа-яЁё]/g) ?? []).toEqual([]);
    }
  });

  // Карточка вехи показывает `verdict.text` как есть: в английском интерфейсе
  // строка вердикта была русской (E1, остаток 1).
  it.each([
    ['en', 'Milestone “1.4”: too early to ship. Failures: 1.'],
    ['ru', 'Веха «1.4»: отдавать рано. Провалов: 1.'],
  ])('вердикт экрана, панель %s — «%s»', async (lang, verdict) => {
    language = lang;
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/release',
      query: { path: project, release: '1.4' },
    });
    const { document } = response.json<{ document: ProjectTestReleaseDocument }>();
    expect(document.verdict.text.startsWith(verdict), document.verdict.text).toBe(true);
    if (lang === 'en') expect(document.verdict.text.match(/[А-Яа-яЁё]/g) ?? []).toEqual([]);
  });

  it('экран получает код оговорки трекера, чтобы перевести её', async () => {
    language = 'en';
    const response = await app.inject({
      method: 'GET',
      url: '/api/project-tests/release',
      query: { path: project, release: '1.4' },
    });
    const { document } = response.json<{ document: ProjectTestReleaseDocument }>();
    expect(document.warningCode).toBe('coverage-atlassian-off');
  });
});
