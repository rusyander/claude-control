import type { FastifyInstance } from 'fastify';
import { readGroups } from '../../domains/project-tests.ts';
import { buildCoverage } from '../../domains/project-tests/coverage.ts';
import { refreshDefectStates } from '../../domains/project-tests/defect-status.ts';
import { IntegrationError } from '../../domains/integrations/errors.ts';
import { guardAsync, requireRoot, type TestsDeps } from './shared.ts';
import { codeOf } from '../../lib/server-text.ts';

/**
 * Покрытие требований и судьба дефектов — два вопроса, на которые раздел тестов
 * сам ответить не может: оба требуют чужой системы.
 *
 * Отдельным модулем, а не внутри библиотеки: у обоих маршрутов есть сеть, и оба
 * обязаны отвечать 200 с оговоркой, когда чужая система молчит. Раздел тестов
 * работает и без единой интеграции — это его свойство, и ломать его ради двух
 * ручек нельзя.
 */
export function registerTestCoverageRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const coverageDeps = (root: string) => ({
    store: deps.ctx.store,
    appDataDir: deps.ctx.location.paths.appData,
    root,
  });

  /**
   * Матрица покрытия. POST, а не GET, потому что запрос JQL — это тело, а не
   * адрес: он длинный, со скобками и кавычками, и в строке запроса выглядел бы
   * так, что его невозможно прочесть в журнале.
   */
  app.post<{ Body: { path?: string; jql?: string; linksOnly?: boolean } }>(
    '/api/project-tests/coverage',
    async (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;

      return guardAsync(reply, async () =>
        buildCoverage(coverageDeps(root), readGroups(root), {
          jql: request.body?.jql,
          linksOnly: request.body?.linksOnly === true,
        }),
      );
    },
  );

  /**
   * Спросить трекеры о заведённых дефектах и записать ответ в кейсы.
   *
   * Ответ содержит `recheck` — кейсы, которые провалены, а их дефект уже
   * закрыт. Это и есть повод нажать кнопку: без него связь с трекером
   * односторонняя, и о починке узнают из чужого разговора.
   */
  app.post<{ Body: { path?: string } }>(
    '/api/project-tests/defects/refresh',
    async (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;

      try {
        return await refreshDefectStates(coverageDeps(root), readGroups(root));
      } catch (error) {
        // Отказ интеграции — состояние, а не поломка маршрута: карточка её
        // назовёт, а раздел останется живым.
        if (error instanceof IntegrationError) {
          return reply.code(error.statusCode).send({
            code: error.code,
            message: error.message,
            ...codeOf(error),
            detail: error.detail,
          });
        }
        throw error;
      }
    },
  );
}
