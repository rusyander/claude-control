import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProjectGitResult } from '@claude-control/contracts';
import {
  GitError,
  checkoutBranch,
  commitAll,
  createBranch,
  readProjectGit,
} from '../domains/project-git.ts';

/**
 * Маршруты git выбранного проекта: состояние, переключение ветки, создание
 * ветки, коммит.
 *
 * Чтение свободно и всегда отвечает 200 — даже «это не репозиторий» (`isRepo:
 * false`) и «git сломан» (`error`) — это ответ, а не ошибка запроса: клиенту
 * надо решить, показывать ли пульт. А вот любая ЗАПИСЬ, которая не удалась,
 * отвечает 400 с текстом самого git: подменять его формулировку своей — значит
 * прятать от пользователя то единственное, что объясняет отказ.
 */
export function registerProjectGitRoutes(app: FastifyInstance): void {
  /** Путь из запроса должен быть абсолютным — искать репозиторий больше негде. */
  const requirePath = (path: string | undefined, reply: FastifyReply): string | undefined => {
    if (!path || !isAbsolute(path)) {
      void reply.code(400).send({ message: 'Нужен абсолютный путь к каталогу проекта' });
      return undefined;
    }
    return path;
  };

  /** Обёртка записи: результат = новое состояние + вывод git. */
  const write = async (
    path: string,
    reply: FastifyReply,
    action: () => Promise<string>,
  ): Promise<ProjectGitResult | FastifyReply> => {
    try {
      const output = await action();
      return { info: await readProjectGit(path), output };
    } catch (error) {
      if (error instanceof GitError) return reply.code(400).send({ message: error.message });
      throw error;
    }
  };

  /** Состояние репозитория: ветка, список веток, сколько файлов изменено. */
  app.get<{ Querystring: { path?: string } }>('/api/project-git', async (request, reply) => {
    const path = requirePath(request.query.path, reply);
    if (!path) return reply;
    return readProjectGit(path);
  });

  /** Переключиться на существующую локальную ветку. */
  app.post<{ Body: { path?: string; branch?: string } }>(
    '/api/project-git/checkout',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      const branch = request.body.branch;
      if (typeof branch !== 'string') {
        return reply.code(400).send({ message: 'Не указана ветка' });
      }
      return write(path, reply, () => checkoutBranch(path, branch));
    },
  );

  /** Создать ветку от текущего HEAD и перейти на неё. */
  app.post<{ Body: { path?: string; name?: string } }>(
    '/api/project-git/branch',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      const name = request.body.name;
      if (typeof name !== 'string') {
        return reply.code(400).send({ message: 'Не указано имя ветки' });
      }
      return write(path, reply, () => createBranch(path, name));
    },
  );

  /** Закоммитить все изменения рабочего дерева. */
  app.post<{ Body: { path?: string; message?: string } }>(
    '/api/project-git/commit',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      const message = request.body.message;
      if (typeof message !== 'string') {
        return reply.code(400).send({ message: 'Не указано сообщение коммита' });
      }
      return write(path, reply, () => commitAll(path, message));
    },
  );
}
