import type { ProjectTestSecretsView, ProjectTestsView } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  ProjectTestsNotFoundError,
  declareSecret,
  describeSecrets,
  readEnvironments,
  undeclareSecret,
  writeSecretValue,
} from '../../domains/project-tests.ts';
import { buildView, guard, requireRoot, type TestsDeps } from './shared.ts';
import { coded } from '../../lib/server-text.ts';

/**
 * Доступы стенда: логин, пароль, токен для прогона против настоящего окружения.
 *
 * Разложено на два хранилища намеренно. ИМЯ переменной — в файле проекта: оно
 * едет вместе с репозиторием, и на чужой машине сразу видно, чего не хватает.
 * ЗНАЧЕНИЕ — в зашифрованном хранилище панели, отдельно от git; наружу оно не
 * уходит ни одним ответом этого файла, только маской.
 *
 * Поэтому запись — ДВА действия за один запрос: объявление в файл, значение в
 * хранилище. Порядок такой (сначала файл), чтобы отказ по негодному имени
 * случился ДО того, как секрет ляжет на диск.
 */
export function registerTestSecretRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const appData = (): string => deps.ctx.location.paths.appData;

  /** Окружение из запроса — или отказ с именем того, чего нет. */
  const environmentOf = (root: string, id: unknown) => {
    const environmentId = String(id ?? '').trim();
    const found = readEnvironments(root).find((item) => item.id === environmentId);
    if (!found)
      throw coded(
        new ProjectTestsNotFoundError(`Окружения «${environmentId}» в проекте нет.`),
        'environment-not-found',
        { environmentId },
      );
    return found;
  };

  /** Что объявлено и что из этого заполнено на ЭТОЙ машине. */
  app.get<{ Querystring: { path?: string; environmentId?: string } }>(
    '/api/project-tests/env-secrets',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => {
        const environment = environmentOf(root, request.query.environmentId);
        return {
          environmentId: environment.id,
          secrets: describeSecrets(appData(), root, environment),
        } satisfies ProjectTestSecretsView;
      });
    },
  );

  /**
   * Завести или заменить доступ. Значение необязательно: имя объявляют и на
   * машине, где секрета нет, — так остальные хотя бы узнают, чего им не хватает.
   */
  app.post<{
    Body: {
      path?: string;
      environmentId?: string;
      name?: string;
      title?: string;
      value?: string;
    };
  }>('/api/project-tests/env-secret', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const name = String(request.body?.name ?? '').trim();
    if (!name)
      return reply
        .code(400)
        .send({ message: 'Нужно имя переменной окружения.', messageCode: 'env-var-name-required' });

    return guard(reply, () => {
      const environment = environmentOf(root, request.body?.environmentId);
      const saved = declareSecret(root, environment.id, { name, title: request.body?.title });
      // Значение приходит только тогда, когда человек его тронул: пустое поле
      // формы не должно стирать сохранённый пароль.
      if (typeof request.body?.value === 'string') {
        writeSecretValue(appData(), root, environment.id, name, request.body.value);
      }
      return {
        environmentId: saved.id,
        secrets: describeSecrets(appData(), root, saved),
        view: buildView(root, deps),
      } satisfies ProjectTestSecretsView & { view: ProjectTestsView };
    });
  });

  /** Забыть доступ: объявление из файла проекта и значение из панели — вместе. */
  app.delete<{ Querystring: { path?: string; environmentId?: string; name?: string } }>(
    '/api/project-tests/env-secret',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const name = String(request.query.name ?? '').trim();
      if (!name)
        return reply.code(400).send({
          message: 'Нужно имя переменной окружения.',
          messageCode: 'env-var-name-required',
        });

      return guard(reply, () => {
        const environment = environmentOf(root, request.query.environmentId);
        writeSecretValue(appData(), root, environment.id, name, '');
        const saved = undeclareSecret(root, environment.id, name);
        return {
          environmentId: saved.id,
          secrets: describeSecrets(appData(), root, saved),
          view: buildView(root, deps),
        } satisfies ProjectTestSecretsView & { view: ProjectTestsView };
      });
    },
  );
}
