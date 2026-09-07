import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  applyResults,
  buildDraft,
  createDefect,
  readEnvironments,
  readGroup,
  readRun,
} from '../../domains/project-tests.ts';
import { guard, requireRoot, type TestsDeps } from './shared.ts';

/**
 * Дефект по проваленному кейсу.
 *
 * Черновик собирается ВСЕГДА — из шагов, ожидания и того, что увидели на самом
 * деле. Это половина работы тестировщика, и она не должна зависеть от того,
 * подключён ли трекер.
 *
 * Завести задачу панель умеет только тем, что уже стоит у человека: `gh` или
 * `glab` из PATH. Своих токенов она не просит и в сеть сама не ходит — иначе
 * ради одной кнопки пришлось бы хранить чужие секреты.
 */
export function registerTestDefectRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /** Черновик: заголовок и тело задачи по кейсу и последнему результату. */
  app.post<{
    Body: { path?: string; groupId?: string; caseId?: string; runId?: string };
  }>('/api/project-tests/defect', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const groupId = String(request.body?.groupId ?? '');
    const caseId = String(request.body?.caseId ?? '');

    return guard(reply, () => {
      const group = readGroup(root, groupId);
      const testCase = group.cases.find((item) => item.id === caseId);
      if (!testCase) throw new ProjectTestsNotFoundError(`Кейса «${caseId}» в группе нет.`);

      const record = request.body?.runId ? readRun(root, request.body.runId) : undefined;
      const result = record?.results.find((item) => item.caseId === caseId);
      const environments = readEnvironments(root);
      const live = deps.runs.get(root);

      return {
        draft: buildDraft(testCase, {
          groupId,
          environmentTitle: environments.find((item) => item.id === result?.environmentId)?.title,
          branch: record?.branch ?? live?.branch,
          commit: record?.commit ?? live?.commit,
          result,
          // Хвост лога прикладывается только от ЖИВОГО прогона: в записи
          // истории лога нет, а придумывать его нельзя.
          logTail: live?.log ? live.log.slice(-2000) : undefined,
        }),
      };
    });
  });

  /**
   * Завести задачу в трекере. Нет CLI — 400 с именем того, чего не хватает.
   *
   * Ссылка пишется обратно в кейс: дефект, о котором знает только трекер, через
   * неделю никак не связан с проверкой, которая его нашла, — и тот же баг
   * заводят второй раз.
   */
  app.post<{
    Body: {
      path?: string;
      target?: 'github' | 'gitlab';
      title?: string;
      body?: string;
      groupId?: string;
      caseId?: string;
    };
  }>('/api/project-tests/defect/create', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const target = request.body?.target;
    if (target !== 'github' && target !== 'gitlab') {
      return reply.code(400).send({ message: 'Не указано, куда заводить задачу.' });
    }
    const title = request.body?.title?.trim();
    const body = request.body?.body?.trim();
    if (!title || !body) return reply.code(400).send({ message: 'Нужен заголовок и описание.' });

    return guard(reply, () => {
      const url = createDefect(root, target, title, body);
      const groupId = request.body?.groupId;
      const caseId = request.body?.caseId;
      if (groupId && caseId) {
        const now = new Date().toISOString();
        const testCase = readGroup(root, groupId).cases.find((item) => item.id === caseId);
        // Статус кейса при этом НЕ меняется: заведение задачи — не результат
        // проверки, и подменять им «провалено» значило бы врать отчёту.
        if (testCase) {
          applyResults(
            root,
            [
              {
                groupId,
                caseId,
                status: testCase.status,
                statusId: testCase.statusId,
                at: testCase.lastRunAt,
                defect: { url, title, createdAt: now },
              },
            ],
            now,
          );
        }
      }
      return { url };
    });
  });
}
