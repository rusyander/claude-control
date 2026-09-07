import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DefectTarget } from '@agentdeck/contracts';
import {
  ProjectTestsError,
  ProjectTestsNotFoundError,
  applyResults,
  createDefect,
  readEnvironments,
  readGroup,
  readRun,
} from '../../domains/project-tests.ts';
// Напрямую, а не через фасад раздела: заведение по токену — часть интеграций, и
// фасад тестов (файл соседней зоны ответственности) ради него не трогается.
import {
  buildDraft,
  createTokenDefect,
  type DefectDeps,
} from '../../domains/project-tests/defects.ts';
import { IntegrationError } from '../../domains/integrations/errors.ts';
import { guard, requireRoot, type TestsDeps } from './shared.ts';

/**
 * Дефект по проваленному кейсу.
 *
 * Черновик собирается ВСЕГДА — из шагов, ожидания и того, что увидели на самом
 * деле. Это половина работы тестировщика, и она не должна зависеть от того,
 * подключён ли трекер.
 *
 * Завести задачу можно четырьмя путями, и панель показывает только те, что
 * работают прямо сейчас: `gh`/`glab` из PATH, фордж по сохранённому токену и
 * Jira по привязке проекта. CLI остаётся первым по достоинству — он не требует
 * от панели хранить чужой секрет.
 */
export function registerTestDefectRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const defectDeps = (root: string): DefectDeps => ({
    store: deps.ctx.store,
    appDataDir: deps.ctx.location.paths.appData,
    root,
  });

  /** Ссылка на заведённую задачу — обратно в кейс, чтобы связь не потерялась. */
  const rememberDefect = (
    root: string,
    url: string,
    title: string,
    groupId?: string,
    caseId?: string,
  ): void => {
    if (!groupId || !caseId) return;
    const now = new Date().toISOString();
    const testCase = readGroup(root, groupId).cases.find((item) => item.id === caseId);
    if (!testCase) return;
    // Статус кейса при этом НЕ меняется: заведение задачи — не результат
    // проверки, и подменять им «провалено» значило бы врать отчёту.
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
  };

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
          deps: defectDeps(root),
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
      target?: DefectTarget;
      title?: string;
      body?: string;
      groupId?: string;
      caseId?: string;
    };
  }>('/api/project-tests/defect/create', async (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const target = request.body?.target;
    if (target !== 'github' && target !== 'gitlab' && target !== 'forge' && target !== 'jira') {
      return reply.code(400).send({ message: 'Не указано, куда заводить задачу.' });
    }
    const title = request.body?.title?.trim();
    const body = request.body?.body?.trim();
    if (!title || !body) return reply.code(400).send({ message: 'Нужен заголовок и описание.' });

    try {
      const url =
        target === 'github' || target === 'gitlab'
          ? createDefect(root, target, title, body)
          : await createTokenDefect(defectDeps(root), target, title, body);
      rememberDefect(root, url, title, request.body?.groupId, request.body?.caseId);
      return { url };
    } catch (error) {
      return failCreate(reply, error);
    }
  });
}

/**
 * Отказ заведения одинаково понятен, откуда бы он ни пришёл: у ошибки CLI и у
 * ошибки интеграции разные классы, но для человека это одна ситуация — «задачу
 * не завели, вот почему».
 */
function failCreate(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof IntegrationError) {
    return reply
      .code(error.statusCode)
      .send({ code: error.code, message: error.message, detail: error.detail });
  }
  if (error instanceof ProjectTestsError) {
    return reply.code(error.statusCode || 400).send({ message: error.message });
  }
  throw error;
}
