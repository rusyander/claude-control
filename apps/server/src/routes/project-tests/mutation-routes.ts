import type { FastifyInstance } from 'fastify';
import type { ProjectTestMutationView } from '@agentdeck/contracts';
import { mutationCandidates, runSecrets } from '../../domains/project-tests.ts';
import {
  assertNoE2eForMutation,
  assertOwnProject,
  guard,
  requireRoot,
  type TestsDeps,
} from './shared.ts';

/**
 * Проверка набора кейсов поломкой (решение владельца 30.09): только по кнопке
 * человека — это прогон автотестов в копии репозитория, минуты и больше.
 *
 * - `GET /api/project-tests/mutation?path` — последняя проверка проекта и
 *   файлы, которые есть что ломать (на них указывают `codePaths` автокейсов).
 * - `POST /api/project-tests/mutation` `{ path, file, mode?, environmentId? }` —
 *   начать; идёт в фоне, ответ — состояние сразу. Вторая на тот же проект или
 *   при идущих автотестах проекта — 409 (Ф11).
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

  app.post<{ Body: { path?: string; file?: string; mode?: string; environmentId?: string } }>(
    '/api/project-tests/mutation',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        assertOwnProject(deps, root);
        assertNoE2eForMutation(deps, root);
        deps.mutations?.start({
          root,
          appData,
          file: String(request.body?.file ?? ''),
          mode: request.body?.mode === 'subtle' ? 'subtle' : 'break',
          ...(typeof request.body?.environmentId === 'string'
            ? { environmentId: request.body.environmentId }
            : {}),
          // Ветка e2e идёт в стенд с теми же доступами, что прогон e2e раздела (Ф8).
          secrets: (environment) => runSecrets(appData, root, environment),
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
