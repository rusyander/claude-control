import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectTestsView } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { ProjectTestRunRegistry } from '../domains/project-tests.ts';
import { registerProjectTestsRoutes } from './project-tests-routes.ts';

/**
 * Маршруты тест-кейсов. Прогон агента здесь не запускается: он спавнит
 * настоящий CLI, и проверять им нечего — важно другое. Чужой каталог не
 * читается, сломанная группа не роняет ответ, а правка кейса возвращает уже
 * пересобранный список, чтобы клиенту не приходилось делать второй запрос.
 */
describe('project-tests-routes', () => {
  let app: FastifyInstance;
  let project = '';

  const view = async (path = project): Promise<ProjectTestsView> => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${encodeURIComponent(path)}`,
    });
    return response.json() as ProjectTestsView;
  };

  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-tests-routes-'));
    app = Fastify();
    registerProjectTestsRoutes(app, {} as unknown as ServerContext, new ProjectTestRunRegistry());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('пустой проект отдаёт пустой список, а не ошибку', async () => {
    const body = await view();

    expect(body.dir).toBe('.agent/tests');
    expect(body.groups).toEqual([]);
    expect(body.run).toBeUndefined();
  });

  it('несуществующий каталог отклоняется', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/project-tests?path=${encodeURIComponent(join(project, 'нет-такого'))}`,
    });

    expect(response.statusCode).toBe(400);
  });

  it('заводит группу, добавляет кейс и возвращает список одним ответом', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui', title: 'GUI' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: {
        path: project,
        groupId: 'gui',
        testCase: { title: 'Отправить сообщение', steps: ['открыть чат', 'нажать «Отправить»'] },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ProjectTestsView;
    expect(body.groups[0]?.cases[0]).toMatchObject({
      title: 'Отправить сообщение',
      source: 'human',
      status: 'unknown',
    });
  });

  it('кейс без названия не создаётся', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui' },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/case',
      payload: { path: project, groupId: 'gui', testCase: { title: '   ', steps: [] } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('сломанный файл группы приходит ошибкой ВНУТРИ группы, ответ остаётся рабочим', async () => {
    mkdirSync(join(project, '.agent', 'tests'), { recursive: true });
    writeFileSync(join(project, '.agent', 'tests', 'gui.tests.json'), '{ сломано');

    const body = await view();

    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.error).toBeTruthy();
  });

  it('прогон по проекту без кейсов не запускается', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/project-tests/run',
      payload: { path: project, mode: 'run' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('соглашение вписывается в CLAUDE.md один раз и видно в ответе', async () => {
    expect((await view()).hasConvention).toBe(false);

    const first = (
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/convention',
        payload: { path: project },
      })
    ).json() as ProjectTestsView;
    expect(first.hasConvention).toBe(true);

    const written = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
    // Повтор ничего не добавляет: кнопку можно нажать дважды без последствий.
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/convention',
      payload: { path: project },
    });
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe(written);
  });

  it('чужой текст CLAUDE.md остаётся на месте', async () => {
    writeFileSync(
      join(project, 'CLAUDE.md'),
      ['# Мой проект', '', 'Что-то важное.', ''].join('\n'),
    );

    await app.inject({
      method: 'POST',
      url: '/api/project-tests/convention',
      payload: { path: project },
    });

    const written = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
    expect(written.startsWith('# Мой проект')).toBe(true);
    expect(written).toContain('Что-то важное.');
    expect(written).toContain('.agent/tests/');
  });

  it('удаление кейса и группы отражается в ответе', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/project-tests/group',
      payload: { path: project, id: 'gui' },
    });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/project-tests/case',
        payload: { path: project, groupId: 'gui', testCase: { title: 'Тест', steps: [] } },
      })
    ).json() as ProjectTestsView;
    const caseId = created.groups[0]?.cases[0]?.id ?? '';

    const afterCase = (
      await app.inject({
        method: 'DELETE',
        url: `/api/project-tests/case?path=${encodeURIComponent(project)}&groupId=gui&caseId=${caseId}`,
      })
    ).json() as ProjectTestsView;
    expect(afterCase.groups[0]?.cases).toEqual([]);

    const afterGroup = (
      await app.inject({
        method: 'DELETE',
        url: `/api/project-tests/group?path=${encodeURIComponent(project)}&id=gui`,
      })
    ).json() as ProjectTestsView;
    expect(afterGroup.groups).toEqual([]);
  });
});
