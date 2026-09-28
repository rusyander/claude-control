import type { FastifyInstance } from 'fastify';
import { readCaseHistory, readFlakyMarks } from '../../domains/project-tests/case-history.ts';
import { guard, requireRoot, type TestsDeps } from './shared.ts';

/**
 * История результатов кейса по прогонам и отметки «нестабилен» для библиотеки.
 *
 * Оба маршрута только читают записи прогонов: ни реестры, ни сеть им не нужны,
 * поэтому отдельный модуль, а не довесок к маршрутам прогонов.
 */
export function registerTestCaseHistoryRoutes(app: FastifyInstance, _deps: TestsDeps): void {
  app.get<{ Querystring: { path?: string; groupId?: string; caseId?: string } }>(
    '/api/project-tests/case-history',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const groupId = String(request.query.groupId ?? '').trim();
      const caseId = String(request.query.caseId ?? '').trim();
      if (!groupId || !caseId) {
        return reply.code(400).send({
          message: 'Не указан кейс, чью историю показать.',
          messageCode: 'case-history-case-unspecified',
        });
      }
      return guard(reply, () => readCaseHistory(root, groupId, caseId));
    },
  );

  app.get<{ Querystring: { path?: string } }>('/api/project-tests/flaky', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => readFlakyMarks(root));
  });
}
