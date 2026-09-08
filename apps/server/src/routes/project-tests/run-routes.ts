import type { ProjectTestGenerateSource, ProjectTestRunMode } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  buildReport,
  collectSource,
  diffWithPrevious,
  historyOf,
  impactOf,
  readGroups,
  readRun,
  readRuns,
  runSecrets,
} from '../../domains/project-tests.ts';
import { exportRunPdf } from '../../domains/project-tests/export-run.ts';
import { buildView, guard, guardAsync, idList, requireRoot, type TestsDeps } from './shared.ts';

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
      release?: string;
      autoAccept?: boolean;
      source?: ProjectTestGenerateSource;
      sourceRef?: string;
      diffRange?: string;
      sourceCase?: { groupId: string; caseId: string; runId?: string };
    };
  }>('/api/project-tests/run', async (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const asked = request.body?.mode;
    const mode = asked && MODES.includes(asked) ? asked : 'run';
    const source = request.body?.source;

    // Галочка помнится на проект: не сказали — берём запомненное, сказали —
    // запоминаем. Иначе положение из формы запуска и положение из окна приёмки
    // жили бы отдельно и расходились после первого же прогона.
    const asking = request.body?.autoAccept;
    if (mode === 'generate' && typeof asking === 'boolean') {
      deps.ctx.store.setTestsAutoAccept(root, asking);
    }
    const autoAccept = mode === 'generate' && deps.ctx.store.isTestsAutoAccept(root);

    const run = {
      projectPath: root,
      mode,
      groupId: request.body?.groupId || undefined,
      caseIds: idList(request.body?.caseIds),
      planId: request.body?.planId || undefined,
      environmentId: request.body?.environmentId || undefined,
      scope: request.body?.scope?.trim() || undefined,
      full: request.body?.full === true,
      changedOnly: request.body?.changedOnly === true,
      release: request.body?.release?.trim() || undefined,
      autoAccept,
      // Источник имеет смысл только у генерации: «прогнать по требованию»
      // означало бы прогнать кейсы, которых ещё нет.
      source: mode === 'generate' ? source : undefined,
      sourceRef: request.body?.sourceRef?.trim() || undefined,
      diffRange: request.body?.diffRange?.trim() || undefined,
      sourceCase: request.body?.sourceCase,
    };

    return guardAsync(reply, async () => {
      // Материал собирается ДО старта: не собрался — прогон не начинается, и
      // человек читает причину. Генерация «по требованию» без требования
      // написала бы правдоподобные кейсы ни о чём.
      const material = await collectSource(
        { store: deps.ctx.store, appDataDir: deps.ctx.location.paths.appData, root },
        run,
        readGroups(root),
      );
      // Доступы стенда собирает МАРШРУТ по той же причине, что и материал: ключи
      // лежат в каталоге панели и зашифрованы, а домен обязан считаться на голом
      // каталоге проекта. Значения уходят в переменные процесса CLI и больше
      // никуда — ни в задание, ни в лог, ни в историю прогонов.
      deps.runs.start(run, new Date().toISOString(), material, (environment) =>
        runSecrets(deps.ctx.location.paths.appData, root, environment),
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

  /**
   * Что изменилось с прошлого прогона.
   *
   * `baseId` пуст — сравниваем с ближайшим прогоном СТАРШЕ этого, у которого
   * есть результаты: генерация и импорт лежат в той же истории, а сравнивать с
   * генерацией нечего.
   */
  app.get<{ Querystring: { path?: string; id?: string; baseId?: string } }>(
    '/api/project-tests/run/diff',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const id = request.query.id?.trim();
      if (!id) return reply.code(400).send({ message: 'Не указан прогон.' });
      return guard(reply, () =>
        diffWithPrevious(root, id, request.query.baseId?.trim() || undefined, readGroups(root)),
      );
    },
  );

  /**
   * Отчёт по прогону в PDF — печатает браузер машины (`domains/project-tests/pdf.ts`).
   *
   * Отдельным маршрутом, а не форматом у общего экспорта: печать асинхронная и
   * может честно ответить «нечем» (501 с именем того, что поставить). Остальные
   * форматы того же отчёта (md, csv, html) отдаёт `GET /run/export`.
   */
  app.get<{ Querystring: { path?: string; id?: string } }>(
    '/api/project-tests/run/pdf',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guardAsync(reply, async () => {
        const file = await exportRunPdf(root, String(request.query.id ?? ''));
        return reply
          .type(file.contentType)
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Cache-Control', 'no-store')
          .send(file.body);
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
