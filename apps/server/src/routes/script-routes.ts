import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  readScripts,
  readScriptContent,
  saveScript,
  deleteScript,
  UnsafeScriptPathError,
} from '../domains/scripts.ts';
import { readHooks } from '../domains/hooks.ts';

/**
 * Отказ по пути — 400 с явной причиной. Молча подставлять «очищенный» путь
 * нельзя: правка ушла бы в другой файл, а ответ выглядел бы успехом.
 */
function replyUnsafePath(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof UnsafeScriptPathError) {
    return reply.code(400).send({ error: 'unsafe_path', message: error.message });
  }
  throw error;
}

/** Маршруты скриптов из каталога hooks/. */
export function registerScriptRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/scripts', () => {
    // Отмечаем, какие скрипты реально вызываются: неиспользуемые файлы
    // копятся годами, и полезно видеть, что можно убрать.
    const usedPaths = readHooks(ctx.location.paths.settings, ctx.store)
      .map((hook) => hook.scriptPath)
      .filter((path): path is string => Boolean(path));

    return readScripts(ctx.location.paths.hooks, usedPaths);
  });

  // Wildcard, а не `:id`: идентификатор скрипта может быть вложенным путём
  // (файл в подпапке hooks/), а `:id` остановился бы на первом слэше.
  app.get<{ Params: { '*': string } }>('/api/scripts/*', (request, reply) => {
    try {
      return {
        id: request.params['*'],
        content: readScriptContent(ctx.location.paths.hooks, request.params['*']),
      };
    } catch (error) {
      return replyUnsafePath(reply, error);
    }
  });

  app.put<{ Params: { '*': string }; Body: { content?: string } }>(
    '/api/scripts/*',
    (request, reply) => {
      // Тела нет — записывать нечего. Молча сохранить пустоту здесь означало бы
      // затереть работающий хук пользователя оборвавшимся запросом.
      if (typeof request.body.content !== 'string') {
        return reply.code(400).send({ message: 'Не передано содержимое скрипта' });
      }

      try {
        return {
          ok: true,
          backupPath: saveScript(
            ctx.location.paths.hooks,
            request.params['*'],
            request.body.content,
            ctx.backupDir,
          ),
          needsRestart: true,
        };
      } catch (error) {
        return replyUnsafePath(reply, error);
      }
    },
  );

  app.post<{ Body: { name?: string; content?: string } }>('/api/scripts', (request, reply) => {
    // Имя обязательно и домыслить его нечем: без него запрос уходил в запись и
    // возвращал 500 — «сломалась панель» вместо «не хватает поля».
    const name = typeof request.body.name === 'string' ? request.body.name.trim() : '';
    if (!name) return reply.code(400).send({ message: 'Не указано имя скрипта' });

    try {
      return {
        ok: true,
        backupPath: saveScript(
          ctx.location.paths.hooks,
          name,
          request.body.content ?? '',
          ctx.backupDir,
        ),
        needsRestart: true,
      };
    } catch (error) {
      return replyUnsafePath(reply, error);
    }
  });

  app.delete<{ Params: { '*': string } }>('/api/scripts/*', (request, reply) => {
    try {
      return {
        ok: true,
        backupPath: deleteScript(ctx.location.paths.hooks, request.params['*'], ctx.backupDir),
        needsRestart: true,
      };
    } catch (error) {
      return replyUnsafePath(reply, error);
    }
  });
}
