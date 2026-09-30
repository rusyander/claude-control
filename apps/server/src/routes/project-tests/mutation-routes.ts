import type { FastifyInstance } from 'fastify';
import type { ProjectTestMutationView } from '@agentdeck/contracts';
import { mutationCandidates } from '../../domains/project-tests.ts';
import { assertOwnProject, guard, requireRoot, type TestsDeps } from './shared.ts';

/**
 * Проверка набора кейсов поломкой (решение владельца 30.09): только по кнопке
 * человека — это прогон автотестов в копии репозитория, минуты и больше.
 *
 * - `GET /api/project-tests/mutation?path` — последняя проверка проекта и
 *   файлы, которые есть что ломать (на них указывают `codePaths` автокейсов).
 * - `POST /api/project-tests/mutation` `{ path, file, mode? }` — начать; идёт в
 *   фоне, ответ — состояние сразу. Вторая на тот же проект — 409.
 * - `POST /api/project-tests/mutation/stop` `{ path }` — остановить.
 *
 * Каталог не из реестра и не копия его ветки — 403: команда здесь исполняется.
 */
export function registerTestMutationRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const appData = deps.ctx.location.paths.appData;
  const view = (root: string): ProjectTestMutationView => {
    const check = deps.mutations?.status(root);
    return { ...(check ? { check } : {}), candidates: mutationCandidates(root) };
  };

  app.get<{ Querystring: { path?: string } }>('/api/project-tests/mutation', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return guard(reply, () => view(root));
  });

  app.post<{ Body: { path?: string; file?: string; mode?: string } }>(
    '/api/project-tests/mutation',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertOwnProject(deps, root);
        deps.mutations?.start({
          root,
          appData,
          file: String(request.body?.file ?? ''),
          mode: request.body?.mode === 'subtle' ? 'subtle' : 'break',
        });
        return view(root);
      });
    },
  );

  app.post<{ Body: { path?: string } }>('/api/project-tests/mutation/stop', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => {
      deps.mutations?.stop(root);
      return view(root);
    });
  });
}
