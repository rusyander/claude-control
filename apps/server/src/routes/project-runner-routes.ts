import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  ProjectRunnerRegistry,
  RunnerError,
  describePort,
  describeRunner,
  freePort,
  resolveTargetDir,
} from '../domains/project-runner.ts';

/**
 * Маршруты запуска/остановки dev-серверов проекта.
 *
 * Адресуется не проект, а ЦЕЛЬ: корень вкладки (`path`) плюс подпапка (`dir`).
 * У монорепы целей несколько и работать они могут одновременно, поэтому
 * настройки — команда, закреплённый порт, автозапуск — тоже хранятся на цель.
 *
 * Реестр запущенных серверов передаётся снаружи (создаётся в `index.ts`), чтобы
 * при выходе сервера панели их можно было погасить одним `stopAll`.
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

  /** Что панель помнит про цель — в форме, которую ждёт `describeRunner`. */
  const memoryOf = (targetPath: string) => {
    const prefs = ctx.store.getRunnerPrefs(targetPath);
    const command = ctx.store.getRunnerCommand(targetPath);
    if (!prefs && !command) return undefined;
    return { ...prefs, command };
  };

  /** Список запущенных dev-серверов — клиент поллит его каждые ~2с. */
  app.get('/api/project-runner', () => registry.list());

  /** Что в этом проекте можно запустить: корень и пакеты монорепозитория. */
  app.get<{ Querystring: { path?: string } }>('/api/project-runner/describe', (request, reply) => {
    const path = requirePath(request.query.path, reply);
    if (!path) return reply;
    return describeRunner(path, memoryOf);
  });

  /**
   * Настройки цели без запуска: команда и закреплённый порт. Пустая строка
   * очищает команду, `null`/0 снимает закрепление порта — иначе снять их было бы
   * нечем. Не переданное поле не трогаем.
   */
  app.post<{ Body: { path?: string; dir?: string; command?: string; port?: number | null } }>(
    '/api/project-runner/settings',
    (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;

      try {
        const target = resolveTargetDir(path, request.body.dir);
        const meta = { projectPath: path, dir: target.dir };
        if (request.body.command !== undefined) {
          ctx.store.setRunnerCommand(target.path, request.body.command, meta);
        }
        if (request.body.port !== undefined) {
          ctx.store.setRunnerPort(target.path, request.body.port ?? undefined, meta);
        }
        return describeRunner(path, memoryOf);
      } catch (error) {
        if (error instanceof RunnerError) return reply.code(400).send({ message: error.message });
        throw error;
      }
    },
  );

  /**
   * Тумблер автозапуска цели. Ничего не запускает и не гасит здесь и сейчас: он
   * о СЛЕДУЮЩЕМ старте сервера панели.
   */
  app.post<{ Body: { path?: string; dir?: string; enabled?: boolean } }>(
    '/api/project-runner/autostart',
    (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      if (typeof request.body.enabled !== 'boolean') {
        return reply.code(400).send({ message: 'Поле enabled должно быть булевым' });
      }

      try {
        const target = resolveTargetDir(path, request.body.dir);
        ctx.store.setRunnerAutostart(target.path, request.body.enabled, {
          projectPath: path,
          dir: target.dir,
        });
        return describeRunner(path, memoryOf);
      } catch (error) {
        if (error instanceof RunnerError) return reply.code(400).send({ message: error.message });
        throw error;
      }
    },
  );

  /**
   * Снять автозапуск со всех целей проекта — этим маршрутом закрытая вкладка
   * держит своё обещание «вкладки нет, автозапуска тоже».
   */
  app.post<{ Body: { path?: string } }>('/api/project-runner/autostart/clear', (request, reply) => {
    const path = requirePath(request.body?.path, reply);
    if (!path) return reply;
    ctx.store.clearRunnerAutostart(path);
    return describeRunner(path, memoryOf);
  });

  /**
   * Запустить dev-сервер цели. Переданная команда сохраняется (пустая строка =
   * сбросить), поэтому один и тот же оверрайд действует и при следующем запуске.
   * Порт панель не назначает: он читается из вывода сервера, а закреплённый
   * берётся из настроек цели.
   */
  app.post<{ Body: { path?: string; dir?: string; command?: string } }>(
    '/api/project-runner/start',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;

      try {
        const target = resolveTargetDir(path, request.body.dir);
        if (request.body.command !== undefined) {
          ctx.store.setRunnerCommand(target.path, request.body.command, {
            projectPath: path,
            dir: target.dir,
          });
        }

        return await registry.start(
          { projectPath: path, dir: target.dir },
          {
            command: ctx.store.getRunnerCommand(target.path),
            port: ctx.store.getRunnerPrefs(target.path)?.pinnedPort,
          },
        );
      } catch (error) {
        if (error instanceof RunnerError) {
          // Занятый порт отдаём номером: по нему панель предложит освободить.
          return reply.code(400).send({ message: error.message, busyPort: error.port });
        }
        throw error;
      }
    },
  );

  /** Номер порта из запроса — иначе освобождать нечего. */
  const requirePort = (
    port: number | undefined,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): number | undefined => {
    if (!Number.isInteger(port) || !port || port < 1 || port > 65_535) {
      reply.code(400).send({ message: 'Нужен номер порта' });
      return undefined;
    }
    return port;
  };

  /** Кто занимает порт: панель показывает это до того, как что-то убивать. */
  app.get<{ Querystring: { port?: string } }>(
    '/api/project-runner/port',
    async (request, reply) => {
      const port = requirePort(Number(request.query.port), reply);
      if (!port) return reply;
      return await describePort(port, (pid) => registry.ownsPid(pid, port));
    },
  );

  /**
   * Освободить порт: погасить занявшие его процессы. Только по явной команде
   * пользователя из панели — сама она чужие процессы не трогает.
   */
  app.post<{ Body: { port?: number } }>('/api/project-runner/free-port', async (request, reply) => {
    const port = requirePort(request.body?.port, reply);
    if (!port) return reply;
    return await freePort(port, (pid) => registry.ownsPid(pid, port));
  });

  /** Остановить dev-сервер цели — убить дерево процессов. */
  app.post<{ Body: { path?: string; dir?: string } }>(
    '/api/project-runner/stop',
    (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      try {
        return { ok: registry.stop({ projectPath: path, dir: request.body.dir }) };
      } catch (error) {
        if (error instanceof RunnerError) return reply.code(400).send({ message: error.message });
        throw error;
      }
    },
  );
}
