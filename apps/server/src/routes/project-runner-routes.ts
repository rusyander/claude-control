import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { ProjectRunnerRegistry, RunnerError, describeRunner } from '../domains/project-runner.ts';

/**
 * Маршруты запуска/остановки dev-сервера проекта.
 *
 * Реестр запущенных серверов передаётся снаружи (создаётся в `index.ts`), чтобы
 * при выходе сервера панели их можно было погасить одним `stopAll`. Оверрайд
 * команды на проект хранится в состоянии панели (`state.json`, ключ = путь).
 */
export function registerProjectRunnerRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ProjectRunnerRegistry,
): void {
  /** Путь из запроса должен быть абсолютным — иначе запускать нечего. */
  const requirePath = (
    path: string | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): string | undefined => {
    if (!path || !isAbsolute(path)) {
      reply.code(400).send({ message: 'Нужен абсолютный путь к каталогу проекта' });
      return undefined;
    }
    return path;
  };

  /** Список запущенных dev-серверов — клиент поллит его каждые ~2с. */
  app.get('/api/project-runner', () => registry.list());

  /** Можно ли запустить проект и какой командой — для подсказки на кнопке. */
  app.get<{ Querystring: { path?: string } }>('/api/project-runner/describe', (request, reply) => {
    const path = requirePath(request.query.path, reply);
    if (!path) return reply;
    return describeRunner(path, ctx.store.getRunnerCommand(path));
  });

  /**
   * Запустить dev-сервер. Оверрайд команды, если передан, сохраняется в состоянии
   * панели (пустая строка очищает оверрайд). Команда всегда берётся из состояния —
   * так один и тот же оверрайд действует и при следующем запуске.
   */
  app.post<{ Body: { path?: string; command?: string } }>(
    '/api/project-runner/start',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;

      // Оверрайд задан в теле — запоминаем (пустая строка = сбросить).
      if (request.body.command !== undefined)
        ctx.store.setRunnerCommand(path, request.body.command);

      try {
        return await registry.start(path, ctx.store.getRunnerCommand(path));
      } catch (error) {
        if (error instanceof RunnerError) return reply.code(400).send({ message: error.message });
        throw error;
      }
    },
  );

  /** Остановить dev-сервер проекта — убить дерево процессов. */
  app.post<{ Body: { path?: string } }>('/api/project-runner/stop', (request, reply) => {
    const path = requirePath(request.body?.path, reply);
    if (!path) return reply;
    return { ok: registry.stop(path) };
  });
}
