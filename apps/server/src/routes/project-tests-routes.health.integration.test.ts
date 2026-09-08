import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProjectTestLintReport,
  ProjectTestPlan,
  ProjectTestPlanPreview,
  ProjectTestQuarantineReport,
  ProjectTestReleaseDocument,
  ProjectTestRiskReport,
  ProjectTestStatus,
  ProjectTestTaxonomyPlan,
} from '@agentdeck/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerContext } from '../context.ts';
import {
  ProjectTestManualRegistry,
  ProjectTestRunRegistry,
  writeRun,
} from '../domains/project-tests.ts';
import { registerProjectTestsRoutes } from './project-tests-routes.ts';

/**
 * Здоровье набора и сборка планов правилом — через HTTP.
 *
 * Обе счётные вещи проверены юнитами по самим модулям; здесь доказывается
 * другое: маршрут читает ЗА них — библиотеку, дифф, историю, покрытие — и
 * отвечает без единого запуска агента. Оффлайн-машина обязана уметь то же
 * самое, поэтому ни один тест здесь не поднимает ни CLI, ни сеть.
 */
describe('project-tests-routes: здоровье набора и планы правилом', () => {
  let app: FastifyInstance;
  let project = '';
  let backupDir = '';

  const post = async (
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const response = await app.inject({ method: 'POST', url, payload });
    return response.json() as Record<string, unknown>;
  };
  const get = async (url: string): Promise<Record<string, unknown>> => {
    const response = await app.inject({ method: 'GET', url });
    return response.json() as Record<string, unknown>;
  };
  const path = (): string => encodeURIComponent(project);

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-health-'));
    backupDir = mkdtempSync(join(tmpdir(), 'cc-tests-health-backups-'));
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      {
        backupDir,
        location: { paths: { appData: backupDir } },
        store: {
          getProjectByPath: () => undefined,
          isTestsAutoAccept: () => false,
          // Ни одна интеграция не подключена: раздел обязан отвечать и так.
          getSettings: () => ({ integrations: { atlassian: { enabled: false } } }),
        },
      } as unknown as ServerContext,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();

    await post('/api/project-tests/group', { path: project, id: 'gui', title: 'GUI' });
    // Два почти одинаковых кейса — то, ради чего линтер и дубликаты нужны.
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: {
        title: 'Вход с пустым паролем',
        steps: [{ action: 'очистить поле пароля', expected: 'форма не отправляется' }],
        oracle: 'сообщение под полем',
        priority: 'blocker',
        duration: 5,
        codePaths: ['src/login'],
      },
    });
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: {
        title: 'Вход с пустым паролем',
        steps: [{ action: 'очистить поле пароля', expected: 'форма не отправляется' }],
      },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(backupDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('линтер называет замечания и дубликаты, но ничего не правит', async () => {
    const before = (await get(`/api/project-tests?path=${path()}`)) as Record<string, unknown>;
    const report = (await get(
      `/api/project-tests/lint?path=${path()}`,
    )) as unknown as ProjectTestLintReport;

    expect(report.checked).toBe(2);
    expect(report.byRule.length).toBeGreaterThan(0);
    // Второй кейс — копия первого: без оракула, без приоритета и с тем же
    // заголовком. Дубликат обязан быть виден отдельно от общих замечаний.
    expect(report.findings.some((item) => item.rule === 'no-oracle')).toBe(true);
    expect(report.duplicates.length).toBeGreaterThan(0);
    expect(report.duplicates[0]?.similar[0]?.score).toBeGreaterThan(0.6);

    // Библиотека после отчёта — та же самая: линтер только читает.
    const after = (await get(`/api/project-tests?path=${path()}`)) as Record<string, unknown>;
    expect(JSON.stringify(after.groups)).toBe(JSON.stringify(before.groups));
  });

  it('замечание с массовым действием называет кнопку, а не правит само', async () => {
    const report = (await get(
      `/api/project-tests/lint?path=${path()}`,
    )) as unknown as ProjectTestLintReport;
    const fixable = report.findings.find((item) => item.fix);

    expect(fixable?.fix?.action).toBeTruthy();
    expect(fixable?.fix?.label).toBeTruthy();
    // Действие обязано быть тем же, что доступно человеку руками: второго пути
    // правки библиотеки в панели нет.
    const applied = await app.inject({
      method: 'POST',
      url: '/api/project-tests/bulk',
      payload: {
        path: project,
        groupId: fixable?.groupId,
        caseIds: [fixable?.caseId],
        action: fixable?.fix?.action,
        value: fixable?.fix?.value,
      },
    });
    expect(applied.statusCode).toBe(200);
  });

  /** История прогонов кейса, от старых к новым. Пишется файлами, как настоящая. */
  const writeHistory = (caseId: string, statuses: ProjectTestStatus[]): void => {
    statuses.forEach((status, index) => {
      const startedAt = `2026-09-0${index + 1}T10:00:00.000Z`;
      writeRun(project, {
        id: `run-${caseId}-${index}`,
        mode: 'run',
        actor: 'agent',
        status: 'done',
        startedAt,
        finishedAt: startedAt,
        results: [{ pointId: `gui:${caseId}`, groupId: 'gui', caseId, status }],
        summary: {
          total: 1,
          passed: status === 'passed' ? 1 : 0,
          failed: status === 'failed' ? 1 : 0,
          skipped: 0,
          blocked: 0,
        },
      });
    });
  };

  it('карантин предлагается снять после зелёной серии, но снимает его человек', async () => {
    await post('/api/project-tests/bulk', {
      path: project,
      groupId: 'gui',
      caseIds: ['gui-001'],
      action: 'mute',
      value: 'ждём починки логина',
    });
    writeHistory('gui-001', ['failed', 'passed', 'passed', 'passed', 'passed', 'passed']);

    const report = (await get(
      `/api/project-tests/quarantine?path=${path()}`,
    )) as unknown as ProjectTestQuarantineReport;

    expect(report.lift).toHaveLength(1);
    expect(report.lift[0]?.caseId).toBe('gui-001');
    expect(report.lift[0]?.muteReason).toBe('ждём починки логина');

    // Ничего не применилось само: кейс как был в карантине, так и остался.
    const view = (await get(`/api/project-tests?path=${path()}`)) as unknown as {
      groups: { cases: { id: string; muted?: boolean }[] }[];
    };
    expect(view.groups[0]?.cases.find((item) => item.id === 'gui-001')?.muted).toBe(true);
  });

  it('нестабильный кейс приезжает предложением с готовой причиной', async () => {
    writeHistory('gui-002', ['passed', 'failed', 'passed', 'failed', 'passed']);

    const report = (await get(
      `/api/project-tests/quarantine?path=${path()}`,
    )) as unknown as ProjectTestQuarantineReport;

    expect(report.quarantine).toHaveLength(1);
    expect(report.quarantine[0]?.caseId).toBe('gui-002');
    expect(report.quarantine[0]?.reason).toContain('Нестабилен');
    expect(report.quarantine[0]?.stability).toBeLessThan(report.thresholds.stability);
  });

  it('без Atlassian даты требований не сверяются — оговоркой, а не молчанием', async () => {
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: {
        title: 'Выход из системы',
        links: [{ type: 'requirement', url: 'https://jira.example/browse/QA-42' }],
      },
    });

    const report = (await get(
      `/api/project-tests/quarantine?path=${path()}`,
    )) as unknown as ProjectTestQuarantineReport;

    expect(report.warning).toContain('Atlassian');
    expect(report.stale).toHaveLength(0);
  });

  it('риск считается по библиотеке и объясняет каждое место словами', async () => {
    writeHistory('gui-002', ['passed', 'failed', 'passed', 'failed']);

    const report = (await get(
      `/api/project-tests/risk?path=${path()}`,
    )) as unknown as ProjectTestRiskReport;

    expect(report.items).toHaveLength(2);
    for (const item of report.items) {
      expect(item.score).toBeGreaterThan(0);
      expect(item.factors).toHaveLength(5);
      expect(item.reason.length).toBeGreaterThan(0);
    }
    // Порядок — по убыванию: это и есть ответ на «с чего начать».
    expect(report.items[0]?.score).toBeGreaterThanOrEqual(report.items[1]?.score ?? 0);
    expect(report.budget).toBeUndefined();
  });

  it('«у меня N минут» набирает под бюджет и называет невлезшее', async () => {
    // Первый кейс просит 5 минут, второй считается по общему допущению; в
    // бюджет из пяти влезает ровно один, и второй обязан быть назван.
    const report = (await get(
      `/api/project-tests/risk?path=${path()}&budget=5`,
    )) as unknown as ProjectTestRiskReport;

    expect(report.budget?.budget).toBe(5);
    expect(report.budget?.minutes).toBeLessThanOrEqual(5);
    expect(report.budget?.picked).toHaveLength(1);
    expect(report.budget?.left).toHaveLength(1);
    expect(report.budget?.left[0]?.title).toBeTruthy();
  });

  /** Прогон, отмеченный вехой: без неё запись в документ готовности не попадает. */
  const writeReleaseRun = (id: string, release: string, caseId: string): void => {
    writeRun(project, {
      id,
      mode: 'run',
      actor: 'agent',
      status: 'done',
      release,
      startedAt: '2026-09-08T10:00:00.000Z',
      finishedAt: '2026-09-08T10:30:00.000Z',
      results: [{ pointId: `gui:${caseId}`, groupId: 'gui', caseId, status: 'passed' }],
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
    });
  };

  it('без вехи маршрут отдаёт список вех, а не ошибку', async () => {
    writeReleaseRun('run-rel-1', '1.4', 'gui-001');

    const answer = (await get(`/api/project-tests/release?path=${path()}`)) as unknown as {
      releases: string[];
      document?: unknown;
    };

    expect(answer.releases).toEqual(['1.4']);
    expect(answer.document).toBeUndefined();
  });

  it('документ готовности считает непроверенное и объясняет вердикт', async () => {
    writeReleaseRun('run-rel-1', '1.4', 'gui-001');

    const answer = (await get(
      `/api/project-tests/release?path=${path()}&release=1.4`,
    )) as unknown as { document: ProjectTestReleaseDocument };
    const doc = answer.document;

    expect(doc.release).toBe('1.4');
    expect(doc.totals.cases).toBe(2);
    expect(doc.totals.passed).toBe(1);
    expect(doc.untested.map((item) => item.caseId)).toEqual(['gui-002']);
    expect(doc.verdict.ready).toBe(false);
    expect(doc.verdict.blockers).toContain('Не проверено кейсов: 1 из 2.');
    // Требования без Atlassian считаются по ссылкам кейсов — с оговоркой.
    expect(doc.warning).toContain('Atlassian');
  });

  it('тот же документ файлом: markdown с вердиктом и именем файла', async () => {
    writeReleaseRun('run-rel-1', '1.4', 'gui-001');

    const file = await app.inject({
      method: 'GET',
      url: `/api/project-tests/release/export?path=${path()}&release=1.4&format=md`,
    });

    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain('release-1.4.md');
    expect(file.body).toContain('# Готовность вехи «1.4»');
    expect(file.body).toContain('**Вердикт:**');
  });

  it('печатать нечем — 501 с именем того, что поставить, а не пустой файл', async () => {
    writeReleaseRun('run-rel-1', '1.4', 'gui-001');
    // Путь к браузеру задан и не существует: ровно то, что видит машина без
    // Chromium. Поиск по системе при заданной переменной не идёт.
    process.env.AGENTDECK_CHROME = join(project, 'нет-такого-браузера.exe');

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/project-tests/release/pdf?path=${path()}&release=1.4`,
      });

      expect(response.statusCode).toBe(501);
      expect(String((response.json() as { message?: string }).message)).toContain('Chrome');
    } finally {
      delete process.env.AGENTDECK_CHROME;
    }
  });

  it('веха не указана или формат чужой — отказ с человеческим текстом', async () => {
    const noRelease = await app.inject({
      method: 'GET',
      url: `/api/project-tests/release/export?path=${path()}&format=md`,
    });
    const badFormat = await app.inject({
      method: 'GET',
      url: `/api/project-tests/release/export?path=${path()}&release=1.4&format=xlsx`,
    });

    expect(noRelease.statusCode).toBe(400);
    expect(String((noRelease.json() as { message?: string }).message)).toContain('веха');
    expect(badFormat.statusCode).toBe(400);
    expect(String((badFormat.json() as { message?: string }).message)).toContain('md');
  });

  it('таксономия предлагает переносы и не трогает содержимое кейсов', async () => {
    const plan = (await get(
      `/api/project-tests/taxonomy?path=${path()}&minCases=2`,
    )) as unknown as ProjectTestTaxonomyPlan;

    expect(Array.isArray(plan.moves)).toBe(true);
    expect(plan.total).toBe(plan.moves.reduce((sum, move) => sum + move.caseIds.length, 0));
    for (const move of plan.moves) {
      expect(move.reason).toBeTruthy();
      expect(move.groupId).toBe('gui');
    }
  });

  it('«дым за N минут» отвечает предпросмотром и не сохраняет план сам', async () => {
    const answer = await post('/api/project-tests/plan/build', {
      path: project,
      recipe: 'smoke',
      budget: 5,
    });
    const preview = answer.preview as ProjectTestPlanPreview;

    expect(preview.recipe).toBe('smoke');
    expect(preview.minutes).toBeLessThanOrEqual(5);
    // Что НЕ влезло — это и есть ответ на «а что я тогда не проверю».
    expect(preview.left.every((item) => item.reason.length > 0)).toBe(true);
    expect(answer.plan).toBeUndefined();

    const plans = (await get(`/api/project-tests/plans?path=${path()}`)) as { plans: unknown[] };
    expect(plans.plans).toHaveLength(0);
  });

  it('тот же запрос с save сохраняет обычный план, который дальше правится руками', async () => {
    const answer = await post('/api/project-tests/plan/build', {
      path: project,
      recipe: 'smoke',
      budget: 30,
      title: 'Дым за полчаса',
      save: true,
    });
    const plan = answer.plan as ProjectTestPlan;

    expect(plan.id).toBeTruthy();
    expect(plan.title).toBe('Дым за полчаса');
    expect(plan.caseIds?.length).toBeGreaterThan(0);
    // Описание объясняет, чем план собран: через месяц это единственный ответ
    // на «откуда здесь этот набор».
    expect(plan.description).toBeTruthy();

    const saved = (await get(`/api/project-tests/plan/points?path=${path()}&id=${plan.id}`)) as {
      points: unknown[];
    };
    expect(saved.points.length).toBeGreaterThan(0);
  });

  it('незнакомое правило — отказ с человеческим текстом, а не 500', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/plan/build',
      payload: { path: project, recipe: 'магия' },
    });

    expect(response.statusCode).toBe(400);
    expect(String((response.json() as { message?: string }).message)).toContain('магия');
  });

  it('«регрессия по диффу» в проекте без правок отвечает пустым отбором, а не ошибкой', async () => {
    const answer = await post('/api/project-tests/plan/build', {
      path: project,
      recipe: 'diff',
    });
    const preview = answer.preview as ProjectTestPlanPreview;

    expect(preview.recipe).toBe('diff');
    expect(preview.picked).toHaveLength(0);
  });
});
