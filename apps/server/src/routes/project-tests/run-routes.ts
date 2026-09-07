import type { ProjectTestRunMode } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  buildReport,
  historyOf,
  impactOf,
  readGroups,
  readRun,
  readRuns,
} from '../../domains/project-tests.ts';
import { buildView, guard, idList, requireRoot, type TestsDeps } from './shared.ts';

/** Режимы прогона: чужое слово в теле не должно запускать неизвестно что. */
const MODES: ProjectTestRunMode[] = ['generate', 'run', 'explore', 'automate'];

/**
 * Прогоны агента, их история и отчёт.
 *
 * Запуск отвечает сразу: агент уходит в фон, а клиент следит за ним тем же
 * `GET /api/project-tests`, который читает файлы кейсов. Ждать окончания в
 * запросе нельзя — прогон сотни кейсов длится десятки минут.
 *
 * История лежит в проекте (`.agent/tests/runs/`), а не в памяти панели: она
 * переживает перезапуск, едет вместе с репозиторием и по ней считаются
 * нестабильные кейсы.
 */
export function registerTestRunRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /**
   * Запустить агента: `generate` — написать кейсы, `run` — пройти их,
   * `explore` — свободный поиск, `automate` — превратить в автотесты.
   */
  app.post<{
    Body: {
      path?: string;
      mode?: ProjectTestRunMode;
      groupId?: string;
      caseIds?: string[];
      planId?: string;
      environmentId?: string;
      scope?: string;
      full?: boolean;
      changedOnly?: boolean;
    };
  }>('/api/project-tests/run', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const asked = request.body?.mode;
    const mode = asked && MODES.includes(asked) ? asked : 'run';

    return guard(reply, () => {
      deps.runs.start(
        {
          projectPath: root,
          mode,
          groupId: request.body?.groupId || undefined,
          caseIds: idList(request.body?.caseIds),
          planId: request.body?.planId || undefined,
          environmentId: request.body?.environmentId || undefined,
          scope: request.body?.scope?.trim() || undefined,
          full: request.body?.full === true,
          changedOnly: request.body?.changedOnly === true,
        },
        new Date().toISOString(),
      );
      return buildView(root, deps);
    });
  });

  /** Остановить прогон. Уже записанные статусы остаются на диске. */
  app.post<{ Body: { path?: string } }>('/api/project-tests/stop', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    deps.runs.stop(root);
    return guard(reply, () => buildView(root, deps));
  });

  /** История прогонов — от новых к старым. */
  app.get<{ Querystring: { path?: string; limit?: string } }>(
    '/api/project-tests/runs',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const limit = Number(request.query.limit ?? 50);
      return guard(reply, () => ({
        runs: readRuns(root, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50),
      }));
    },
  );

  /** Один прогон целиком — с результатами по каждому тест-поинту. */
  app.get<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/run',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const id = String(request.query.id ?? '');
        const run = readRun(root, id);
        if (!run) throw new ProjectTestsNotFoundError(`Прогона «${id}» в истории нет.`);
        return { run };
      });
    },
  );

  /** Отчёт: покрытие по зонам, автоматизация, нестабильные кейсы, расход. */
  app.get<{ Querystring: { path?: string; limit?: string } }>(
    '/api/project-tests/report',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const limit = Number(request.query.limit ?? 50);
      return guard(reply, () =>
        buildReport(
          root,
          readGroups(root),
          Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
        ),
      );
    },
  );

  /**
   * Кейсы, задетые правками рабочей копии.
   *
   * Этого в обычной TMS не бывает: панель видит и кейсы, и дифф рядом, поэтому
   * «прогнать только задетое» — не догадка, а список с причиной по каждому кейсу.
   */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/impact', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => impactOf(root, readGroups(root)));
  });

  /**
   * История файла группы из git: кто и когда правил кейсы.
   *
   * Своего версионирования у раздела нет намеренно — кейсы лежат в репозитории,
   * и git отвечает на этот вопрос вместе с ревью и откатом. Проект без git или
   * ещё не закоммиченный файл — пустая история, а не ошибка.
   */
  app.get<{ Querystring: { path?: string; groupId?: string } }>(
    '/api/project-tests/history',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const groupId = request.query.groupId?.trim();
      if (!groupId) return reply.code(400).send({ message: 'Не указана группа.' });
      return guard(reply, () => ({ entries: historyOf(root, groupId) }));
    },
  );
}
