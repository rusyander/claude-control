import type { ProjectTestGenerateSource, ProjectTestRunMode } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  buildReport,
  collectSource,
  createE2eFolder,
  diffWithPrevious,
  historyOf,
  impactOf,
  readGroups,
  readRun,
  readRuns,
  runSecrets,
} from '../../domains/project-tests.ts';
import { exportLanguage, exportRunPdf } from '../../domains/project-tests/export-run.ts';
import {
  assertNoE2eRun,
  isOwnProject,
  buildView,
  guard,
  guardAsync,
  idList,
  requireRoot,
  settleOrphansOnce,
  type TestsDeps,
} from './shared.ts';
import { coded } from '../../lib/server-text.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { providerCliCandidates } from '../../providers/cli.ts';
import { detectCliOnPath, findCliOnPath } from '../../providers/detect.ts';
import {
  testsAgentDialectOf,
  type TestsAgentProvider,
} from '../../domains/project-tests/agent/agent-runs.ts';
import { attachTextCodes } from '../../lib/server-texts.ts';

/** Режимы прогона: чужое слово в теле не должно запускать неизвестно что. */
const MODES: ProjectTestRunMode[] = ['generate', 'run', 'explore', 'automate'];

/** Без id — ошибка вызова (400), а не «прогона «» нет». */
const RUN_UNSPECIFIED = { message: 'Не указан прогон.', messageCode: 'run-unspecified' } as const;

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
      e2e?: boolean;
    };
  }>('/api/project-tests/run', async (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    // Агент тестов идёт CLI выбранного провайдера, и каждый вызов инструмента
    // сверяется с границами режима: у Claude — брокером прав, у Qwen Code —
    // хуком к тому же приёмнику, у Codex — ответами на его просьбы
    // (`domains/project-tests/agent/`). У прочих CLI такой проверки нет — отказ с
    // именем CLI, а не прогон через Claude молчком (выбор провайдера один на всю
    // панель).
    const active = getActiveProvider(deps.ctx.store);
    const dialect = testsAgentDialectOf(active.id);
    if (!dialect) {
      return reply.code(409).send({
        error: 'provider_unsupported',
        message: `Агент блока «Тесты» работает с Claude Code, Qwen Code и Codex, а активный CLI — ${active.name}. Прогон не запущен.`,
        messageCode: 'tests-agent-provider-unsupported',
        params: { provider: active.name },
      });
    }
    let provider: TestsAgentProvider = { id: 'claude' };
    if (dialect !== 'claude') {
      const command = findCliOnPath(providerCliCandidates(active), detectCliOnPath);
      if (command === undefined) {
        return reply.code(409).send({
          error: 'cli_not_found',
          message: `${active.name} не найден в PATH процесса панели — прогону нечем работать.`,
          messageCode: 'tests-agent-cli-not-found',
          params: { provider: active.name },
        });
      }
      // Маршрут контура у агента тестов собран под Claude: чужой CLI через него
      // не ходит, и прогон молча ушёл бы в облако вендора мимо выбранного контура.
      if (deps.runs.routesThroughContour()) {
        return reply.code(409).send({
          error: 'contour_foreign',
          message: `Через контур агент блока «Тесты» ходит только с Claude Code, а активный CLI — ${active.name}. Прогон не запущен.`,
          messageCode: 'tests-agent-contour-foreign',
          params: { provider: active.name },
        });
      }
      provider = { id: dialect, name: active.name, command };
    }
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
      // Настоящие спеки пишет только генерация: у прочих режимов свой путь к коду.
      // Папку e2e она заводит и спеки гоняет только у проекта реестра или копии его
      // ветки (граница «Завести папку»); в чужом каталоге — те же кейсы без спек.
      e2e: mode === 'generate' && request.body?.e2e === true && isOwnProject(deps, root),
    };

    // Зеркало замка группы: пока человек отмечает кейсы, агент в тот же файл не
    // пишет. Без этого ручной прогон, начатый первым, ронял результаты агента —
    // и наоборот. Прогон без группы (план, вся библиотека) задевает любую.
    const manual = deps.manual.get(root);
    if (manual && !manual.finishedAt) {
      const held = new Set(manual.points.map((point) => point.groupId));
      if (!run.groupId || held.has(run.groupId)) {
        return reply.code(409).send({
          message: `Идёт ручной прогон (${manual.runId}) — он пишет в тот же файл. Закончи или отмени его.`,
          messageCode: 'manual-run-in-progress',
          params: { runId: manual.runId },
          runId: manual.runId,
        });
      }
    }

    return guardAsync(reply, async () => {
      // Автотесты на закрытии пишут в те же файлы групп — агент ждёт их конца.
      assertNoE2eRun(deps, root);
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
      // Генерации с e2e нужна папка: её нет — заводим (правило владельца: папка
      // есть у каждого проекта), своя остаётся как есть.
      // Заводит её реестр, после своих отказов: иначе отказанный старт оставлял
      // папку на диске.
      deps.runs.start(
        run,
        new Date().toISOString(),
        material,
        (environment) => runSecrets(deps.ctx.location.paths.appData, root, environment),
        {
          appData: deps.ctx.location.paths.appData,
          provider,
          ensureE2e: () =>
            createE2eFolder(deps.ctx.location.paths.appData, root, new Date().toISOString()),
        },
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
      // История читается и без полного вида (агент панели): сирота прошлой жизни
      // панели иначе числилась бы идущей, пока кто-нибудь не откроет раздел.
      settleOrphansOnce(root, deps);
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
      // Без id — ошибка вызова, как у сравнения и выгрузки, а не «прогона «» нет».
      const id = request.query.id?.trim();
      if (!id) return reply.code(400).send(RUN_UNSPECIFIED);
      return guard(reply, () => {
        const run = readRun(root, id);
        if (!run)
          throw coded(
            new ProjectTestsNotFoundError(`Прогона «${id}» в истории нет.`),
            'run-not-in-history',
            { id },
          );
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
      if (!id) return reply.code(400).send(RUN_UNSPECIFIED);
      return guard(reply, () =>
        attachTextCodes(
          diffWithPrevious(root, id, request.query.baseId?.trim() || undefined, readGroups(root)),
        ),
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
      const id = request.query.id?.trim();
      if (!id) return reply.code(400).send(RUN_UNSPECIFIED);
      return guardAsync(reply, async () => {
        const file = await exportRunPdf(
          root,
          id,
          exportLanguage(deps.ctx.store.getSettings().language),
        );
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
      if (!groupId)
        return reply
          .code(400)
          .send({ message: 'Не указана группа.', messageCode: 'group-unspecified' });
      return guard(reply, () => ({ entries: historyOf(root, groupId) }));
    },
  );
}
