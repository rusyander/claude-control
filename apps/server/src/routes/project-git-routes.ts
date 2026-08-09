import { resolve } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProjectGitResult } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  GitError,
  checkoutBranch,
  commitAll,
  createBranch,
  pullChanges,
  pushBranch,
  readProjectGit,
} from '../domains/project-git.ts';
import { checkProjectDir } from '../domains/projects.ts';

/**
 * Маршруты git выбранного проекта: состояние, переключение ветки, создание
 * ветки, коммит, подтягивание чужих коммитов.
 *
 * Чтение свободно и всегда отвечает 200 — даже «это не репозиторий» (`isRepo:
 * false`) и «git сломан» (`error`) — это ответ, а не ошибка запроса: клиенту
 * надо решить, показывать ли пульт. А вот любая ЗАПИСЬ, которая не удалась,
 * отвечает 400 с текстом самого git: подменять его формулировку своей — значит
 * прятать от пользователя то единственное, что объясняет отказ.
 *
 * Каталог приходит путём, а не идентификатором реестра, и это осознанно: вкладку
 * проекта можно открыть на любой папке, выбранной в проводнике панели, — она в
 * реестре не числится, а git у неё должен работать. Тот же уговор у рабочего
 * каталога чата. Общего с реестром здесь одно, и этого достаточно: путь проходит
 * через ту же проверку `checkProjectDir`, что и запись в реестр, и дальше в git
 * уходит уже нормализованным.
 *
 * Контекст сервера здесь не нужен — работаем с путём из запроса, — но параметр
 * объявлен: под `RouteRegistrar` подходят все модули маршрутов без исключений.
 */
export function registerProjectGitRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  /**
   * Каталог из запроса, пригодный для запуска git, или undefined с уже
   * отправленным 400. Проверка — общая с реестром проектов: абсолютный путь,
   * каталог существует и это действительно каталог. Наружу отдаётся `resolve`,
   * чтобы дальше по коду ходил один вид пути, а не тот, что прислал клиент.
   */
  const requirePath = (path: string | undefined, reply: FastifyReply): string | undefined => {
    const problem = checkProjectDir(String(path ?? ''));
    if (problem) {
      void reply.code(400).send({ message: problem });
      return undefined;
    }
    return resolve(path as string);
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

  /**
   * Подтянуть чужие коммиты. Без `branch` — обычный `git pull` в текущей ветке;
   * с `branch` — из соответствующей ветки удалённого. Пустая строка приходит от
   * селекта «текущая ветка», поэтому она равнозначна отсутствию поля.
   */
  app.post<{ Body: { path?: string; branch?: string } }>(
    '/api/project-git/pull',
    async (request, reply) => {
      const path = requirePath(request.body?.path, reply);
      if (!path) return reply;
      const branch = request.body.branch;
      if (branch !== undefined && typeof branch !== 'string') {
        return reply.code(400).send({ message: 'Ветка задана неверно' });
      }
      return write(path, reply, () => pullChanges(path, branch));
    },
  );

  /**
   * Отправить текущую ветку. Тела сверх пути нет намеренно: что отправлять,
   * решает состояние репозитория, а не запрос, — иначе кнопка «отправить»
   * умела бы больше, чем показывает.
   */
  app.post<{ Body: { path?: string } }>('/api/project-git/push', async (request, reply) => {
    const path = requirePath(request.body?.path, reply);
    if (!path) return reply;
    return write(path, reply, () => pushBranch(path));
  });
}
