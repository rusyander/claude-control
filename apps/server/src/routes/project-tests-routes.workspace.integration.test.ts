import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ProjectTestManualSession,
  ProjectTestPlan,
  ProjectTestPoint,
  ProjectTestSecretsView,
  ProjectTestsView,
} from '@agentdeck/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerContext } from '../context.ts';
import { ProjectTestManualRegistry, ProjectTestRunRegistry } from '../domains/project-tests.ts';
import { registerProjectTestsRoutes } from './project-tests-routes.ts';

/**
 * Рабочее место тестировщика через HTTP: библиотека, планы, ручной прогон,
 * история и дефекты.
 *
 * Прогон агента здесь не запускается — он спавнит настоящий CLI. Проверяется
 * другое: что человек может пройти кейсы руками и ничего не потерять, что
 * отбор и планы отвечают тем же полным видом, и что чужие идентификаторы
 * получают отказ, а не молчаливый успех.
 */
describe('project-tests-routes: рабочее место', () => {
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
    project = mkdtempSync(join(tmpdir(), 'cc-tests-workspace-'));
    backupDir = mkdtempSync(join(tmpdir(), 'cc-tests-workspace-backups-'));
    app = Fastify();
    registerProjectTestsRoutes(
      app,
      {
        backupDir,
        // Каталог данных панели нужен маршруту дефектов: по нему он смотрит,
        // подключены ли Jira и фордж по токену. Здесь их нет — и черновик
        // обязан собраться всё равно, только с пустым списком назначений.
        location: { paths: { appData: backupDir } },
        // Галочку «принимать сразу» вид спрашивает у панели, а не у проекта:
        // здесь её нет, и это ровно то состояние, в котором приходит человек,
        // ни разу её не трогавший.
        store: { getProjectByPath: () => undefined, isTestsAutoAccept: () => false },
      } as unknown as ServerContext,
      new ProjectTestRunRegistry(),
      new ProjectTestManualRegistry(),
    );
    await app.ready();

    await post('/api/project-tests/group', { path: project, id: 'gui', title: 'GUI' });
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: { title: 'Отправка сообщения', steps: ['нажать'], tags: ['smoke'], area: 'chat' },
    });
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: { title: 'Загрузка файла', steps: ['выбрать'], tags: ['regress'] },
    });
  });

  afterEach(async () => {
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(backupDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('полный вид отдаёт библиотеку целиком одним ответом', async () => {
    const view = (await get(`/api/project-tests?path=${path()}`)) as unknown as ProjectTestsView;

    expect(view.groups[0]?.cases).toHaveLength(2);
    expect(Array.isArray(view.sharedSteps)).toBe(true);
    expect(Array.isArray(view.environments)).toBe(true);
    expect(Array.isArray(view.plans)).toBe(true);
    expect(Array.isArray(view.views)).toBe(true);
    expect(view.schema).toBeTruthy();
  });

  it('повторный опрос без изменений стоит 304, а правка кейса снова отдаёт тело', async () => {
    const first = await app.inject({ method: 'GET', url: `/api/project-tests?path=${path()}` });
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/".+"$/);

    const repeat = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${path()}`,
      headers: { 'if-none-match': etag },
    });
    expect(repeat.statusCode).toBe(304);

    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: { id: 'gui-001', title: 'Отправка сообщения', steps: ['нажать'], status: 'passed' },
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${path()}`,
      headers: { 'if-none-match': etag },
    });
    expect(after.statusCode).toBe(200);
  });

  it('пакетная правка проставляет метку сразу нескольким кейсам', async () => {
    const body = await post('/api/project-tests/bulk', {
      path: project,
      groupId: 'gui',
      caseIds: ['gui-001', 'gui-002'],
      action: 'tag',
      value: 'релиз-1',
    });

    expect(body.touched).toBe(2);
    const view = body.view as ProjectTestsView;
    expect(view.groups[0]?.cases.every((item) => item.tags?.includes('релиз-1'))).toBe(true);
  });

  it('пакетная правка без отмеченных кейсов — отказ, а не пустая работа', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/bulk',
      payload: { path: project, groupId: 'gui', caseIds: [], action: 'archive' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('карантин без причины не ставится: иначе через месяц никто не решится его снять', async () => {
    const refused = await app.inject({
      method: 'POST',
      url: '/api/project-tests/bulk',
      payload: { path: project, groupId: 'gui', caseIds: ['gui-001'], action: 'mute' },
    });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.json().message)).toContain('причины');

    const body = await post('/api/project-tests/bulk', {
      path: project,
      groupId: 'gui',
      caseIds: ['gui-001'],
      action: 'mute',
      value: 'ждём починки логина',
    });
    const view = body.view as ProjectTestsView;
    const muted = view.groups[0]?.cases.find((item) => item.id === 'gui-001');
    expect(muted?.muted).toBe(true);
    expect(muted?.muteReason).toBe('ждём починки логина');

    // Повторный карантин уже объяснённого кейса причину не стирает и не требует
    // ввести её заново.
    const again = await app.inject({
      method: 'POST',
      url: '/api/project-tests/bulk',
      payload: { path: project, groupId: 'gui', caseIds: ['gui-001'], action: 'mute' },
    });
    expect(again.statusCode).toBe(200);
  });

  it('общий шаг и окружение появляются в том же виде', async () => {
    await post('/api/project-tests/shared-step', {
      path: project,
      step: { title: 'Вход в систему', steps: ['открыть', 'ввести логин'] },
    });
    const view = (await post('/api/project-tests/environment', {
      path: project,
      environment: { title: 'Локальное', baseUrl: 'http://127.0.0.1:8888', isDefault: true },
    })) as unknown as ProjectTestsView;

    expect(view.sharedSteps).toHaveLength(1);
    expect(view.environments[0]?.baseUrl).toBe('http://127.0.0.1:8888');
  });

  it('доступ окружения: наружу маска, в файле проекта — только имя переменной', async () => {
    const environment = (
      (await post('/api/project-tests/environment', {
        path: project,
        environment: { title: 'Стенд' },
      })) as unknown as ProjectTestsView
    ).environments[0]!;

    const saved = (await post('/api/project-tests/env-secret', {
      path: project,
      environmentId: environment.id,
      name: 'STAND_PASSWORD',
      title: 'Пароль входа',
      value: 'очень-секретно-42',
    })) as unknown as ProjectTestSecretsView & { view: ProjectTestsView };

    expect(saved.secrets[0]).toMatchObject({ name: 'STAND_PASSWORD', hasValue: true });
    expect(JSON.stringify(saved)).not.toContain('очень-секретно-42');
    // Файл проекта уезжает в git: там имя переменной и подпись, не значение.
    expect(saved.view.environments[0]?.secrets).toEqual([
      { name: 'STAND_PASSWORD', title: 'Пароль входа' },
    ]);
    expect(
      readFileSync(join(project, '.agent', 'tests', 'environments.json'), 'utf8'),
    ).not.toContain('очень-секретно-42');

    const shown = (await get(
      `/api/project-tests/env-secrets?path=${path()}&environmentId=${environment.id}`,
    )) as unknown as ProjectTestSecretsView;
    expect(shown.secrets[0]?.masked).not.toContain('секретно');
    expect(JSON.stringify(shown)).not.toContain('очень-секретно-42');
  });

  it('удаление доступа уносит и объявление, и значение', async () => {
    const environment = (
      (await post('/api/project-tests/environment', {
        path: project,
        environment: { title: 'Стенд' },
      })) as unknown as ProjectTestsView
    ).environments[0]!;
    await post('/api/project-tests/env-secret', {
      path: project,
      environmentId: environment.id,
      name: 'STAND_TOKEN',
      value: 'токен-стенда-1',
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/project-tests/env-secret?path=${path()}&environmentId=${environment.id}&name=STAND_TOKEN`,
    });
    const after = response.json() as ProjectTestSecretsView & { view: ProjectTestsView };

    expect(after.secrets).toEqual([]);
    expect(after.view.environments[0]?.secrets).toBeUndefined();
  });

  it('переменная самой панели под доступ стенда не отдаётся', async () => {
    const environment = (
      (await post('/api/project-tests/environment', {
        path: project,
        environment: { title: 'Стенд' },
      })) as unknown as ProjectTestsView
    ).environments[0]!;

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/env-secret',
      payload: {
        path: project,
        environmentId: environment.id,
        name: 'ANTHROPIC_API_KEY',
        value: 'sk-подмена',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('занята самой панелью');
  });

  it('доступ у окружения, которого нет, — 404, а не молчаливый успех', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests/env-secrets?path=${path()}&environmentId=нет-такого`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('план разворачивается в тест-поинты по числу окружений', async () => {
    const chrome = (
      (await post('/api/project-tests/environment', {
        path: project,
        environment: { title: 'Chrome' },
      })) as unknown as ProjectTestsView
    ).environments[0]!;
    const firefox = (
      (await post('/api/project-tests/environment', {
        path: project,
        environment: { title: 'Firefox' },
      })) as unknown as ProjectTestsView
    ).environments.find((item) => item.title === 'Firefox')!;

    const saved = (await post('/api/project-tests/plan', {
      path: project,
      plan: {
        title: 'Релиз 1.0',
        caseIds: ['gui-001'],
        environmentIds: [chrome.id, firefox.id],
      },
    })) as { plan: ProjectTestPlan };

    const points = (await get(
      `/api/project-tests/plan/points?path=${path()}&id=${saved.plan.id}`,
    )) as { points: ProjectTestPoint[] };

    expect(points.points).toHaveLength(2);
  });

  it('несуществующий план — 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests/plan/points?path=${path()}&id=missing`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('ручной прогон: отмеченный результат виден и в кейсе, и в истории', async () => {
    const started = (await post('/api/project-tests/manual/start', {
      path: project,
      groupId: 'gui',
    })) as { session: ProjectTestManualSession };
    const session = started.session;
    expect(session.points).toHaveLength(2);

    await post('/api/project-tests/manual/result', {
      path: project,
      runId: session.runId,
      pointId: session.points[0]!.id,
      status: 'failed',
      note: 'кнопка неактивна',
    });

    const view = (await get(`/api/project-tests?path=${path()}`)) as unknown as ProjectTestsView;
    expect(view.groups[0]?.cases[0]?.status).toBe('failed');

    const history = (await get(`/api/project-tests/runs?path=${path()}`)) as {
      runs: { actor: string; summary: { failed: number } }[];
    };
    expect(history.runs[0]?.actor).toBe('human');
    expect(history.runs[0]?.summary.failed).toBe(1);
  });

  it('неизвестный статус результата не принимается', async () => {
    const started = (await post('/api/project-tests/manual/start', {
      path: project,
      groupId: 'gui',
    })) as { session: ProjectTestManualSession };

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/manual/result',
      payload: {
        path: project,
        runId: started.session.runId,
        pointId: started.session.points[0]!.id,
        status: 'почти прошёл',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('идущая сессия восстанавливается по GET — после F5 прогон не теряется', async () => {
    const started = (await post('/api/project-tests/manual/start', {
      path: project,
      groupId: 'gui',
    })) as { session: ProjectTestManualSession };

    const current = (await get(`/api/project-tests/manual?path=${path()}`)) as {
      session?: ProjectTestManualSession;
    };

    expect(current.session?.runId).toBe(started.session.runId);
  });

  it('вложение ложится в папку кейса и возвращает путь от корня проекта', async () => {
    const body = (await post('/api/project-tests/attachment', {
      path: project,
      caseId: 'gui-001',
      name: 'shot.png',
      contentBase64: Buffer.from('картинка').toString('base64'),
    })) as { file: string };

    expect(body.file).toContain('.agent/tests/attachments/gui-001/');
  });

  it('черновик дефекта собирается по кейсу даже без трекера', async () => {
    await post('/api/project-tests/case', {
      path: project,
      groupId: 'gui',
      testCase: {
        id: 'gui-001',
        title: 'Отправка сообщения',
        steps: ['нажать «Отправить»'],
        expected: 'сообщение в ленте',
        note: 'ничего не происходит',
      },
    });

    const body = (await post('/api/project-tests/defect', {
      path: project,
      groupId: 'gui',
      caseId: 'gui-001',
    })) as { draft: { title: string; body: string; targets: string[] } };

    expect(body.draft.title).toContain('Отправка сообщения');
    expect(body.draft.body).toContain('нажать «Отправить»');
    expect(body.draft.body).toContain('сообщение в ленте');
    expect(Array.isArray(body.draft.targets)).toBe(true);
  });

  it('обязательное своё поле не пускает пустой кейс, а список — чужое значение', async () => {
    await post('/api/project-tests/schema', {
      path: project,
      schema: {
        attributes: [
          {
            key: 'stand',
            title: 'Стенд',
            type: 'select',
            options: ['dev', 'prod'],
            required: true,
          },
        ],
        statuses: [],
      },
    });

    const empty = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: { path: project, groupId: 'gui', testCase: { title: 'Без стенда', steps: [] } },
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { message: string }).message).toContain('Стенд');

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: {
        path: project,
        groupId: 'gui',
        testCase: { title: 'Чужой стенд', steps: [], attributes: { stand: 'staging' } },
      },
    });
    expect(wrong.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: {
        path: project,
        groupId: 'gui',
        testCase: { title: 'Со стендом', steps: [], attributes: { stand: 'prod' } },
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('дефект по несуществующему кейсу — 404', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/defect',
      payload: { path: project, groupId: 'gui', caseId: 'нет-такого' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('отчёт отвечает и на пустой истории', async () => {
    const report = (await get(`/api/project-tests/report?path=${path()}`)) as {
      areas: { area: string }[];
      automation: Record<string, number>;
      totals: { runs: number };
    };

    expect(report.totals.runs).toBe(0);
    expect(report.areas.some((row) => row.area === 'chat')).toBe(true);
    expect(report.automation.manual).toBe(2);
  });

  it('отбор по диффу вне репозитория пуст — «прогнать задетое» не превращается в «прогнать всё»', async () => {
    const impact = (await get(`/api/project-tests/impact?path=${path()}`)) as {
      files: string[];
      cases: unknown[];
    };

    expect(impact.files).toEqual([]);
    expect(impact.cases).toEqual([]);
  });

  it('прогон только задетого без изменений не стартует', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'run', changedOnly: true },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message: string }).message).toContain('не задели');
  });
});
