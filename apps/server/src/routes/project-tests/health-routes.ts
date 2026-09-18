import type { FastifyInstance } from 'fastify';
import {
  buildQuarantine,
  buildRisk,
  impactOf,
  lintLibrary,
  readGroups,
  readRuns,
  suggestTaxonomy,
} from '../../domains/project-tests.ts';
import { linkedRequirements, requirementUpdates } from '../../domains/project-tests/coverage.ts';
import { guard, guardAsync, requireRoot, type TestsDeps } from './shared.ts';
import { attachTextCodes } from '../../lib/server-texts.ts';

/**
 * Здоровье набора: замечания линтера, дубликаты, таксономия и карантин.
 *
 * Все ответы — ЧТЕНИЕ. Ни линтер, ни таксономия, ни карантин ничего не правят:
 * они называют кейсы и кнопку, которую нажмёт человек. Правило, которое чинит
 * само, однажды сотрёт то, что писали руками, и заметят это через месяц по
 * чужому прогону.
 *
 * Считается на лету, без кэша: библиотека этой панели проходится за доли
 * секунды, а сохранённый отчёт устаревал бы на первой же правке кейса — и врал
 * бы ровно там, где на него смотрят.
 */
export function registerTestHealthRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /** Замечания и дубликаты по всей библиотеке. */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/lint', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    // Заголовки правил свода собраны по кодам (`serverText`) — код к ним
    // восстанавливается разбором, и английский экран показывает английское имя.
    return guard(reply, () =>
      attachTextCodes(lintLibrary(readGroups(root), { now: new Date().toISOString() })),
    );
  });

  /**
   * Карантин и устаревание: кого пора вернуть в строй, кого выключить и какой
   * кейс разошёлся с требованием.
   *
   * Асинхронный, потому что даты требований лежат в трекере. Трекер молчит или
   * выключен — ответ всё равно 200 с оговоркой: обе половины отчёта независимы,
   * и терять предложения по карантину из-за недоступной Jira незачем.
   */
  app.get<{ Querystring: { path?: string } }>(
    '/api/project-tests/quarantine',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guardAsync(reply, async () => {
        const groups = readGroups(root);
        const dates = await requirementUpdates(
          { store: deps.ctx.store, appDataDir: deps.ctx.location.paths.appData, root },
          linkedRequirements(groups),
        );
        return buildQuarantine(groups, readRuns(root), dates, { now: new Date().toISOString() });
      });
    },
  );

  /**
   * Риск и время: чем гнать, если на всё времени нет.
   *
   * Дифф рабочей копии считается ЗДЕСЬ, а не в домене: `impactOf` ходит в git, а
   * счёт риска обязан оставаться чистым — иначе его нельзя закрыть юнитом и
   * нельзя посчитать на машине без репозитория. Не репозиторий — просто пустой
   * дифф: один множитель из пяти замолкает, остальные считаются как обычно.
   */
  app.get<{ Querystring: { path?: string; groupId?: string; budget?: string } }>(
    '/api/project-tests/risk',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const groups = readGroups(root);
        const budget = Number(request.query.budget);
        return buildRisk(groups, readRuns(root), {
          now: new Date().toISOString(),
          impact: impactOf(root, groups),
          groupId: request.query.groupId?.trim() || undefined,
          budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
        });
      });
    },
  );

  /**
   * Предложение разложить кейсы по секциям.
   *
   * Отдельный маршрут от применения намеренно: применяются переносы обычным
   * массовым действием — тем же, что доступно человеку руками, — и второго пути
   * правки библиотеки в панели не появляется.
   */
  app.get<{ Querystring: { path?: string; minCases?: string } }>(
    '/api/project-tests/taxonomy',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const minCases = Number(request.query.minCases);
        return suggestTaxonomy(readGroups(root), {
          minCases: Number.isFinite(minCases) && minCases > 0 ? minCases : undefined,
        });
      });
    },
  );
}
