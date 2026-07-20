import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { readScripts, readScriptContent, saveScript, deleteScript } from '../domains/scripts.ts';
import { readHooks } from '../domains/hooks.ts';

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
  app.get<{ Params: { '*': string } }>('/api/scripts/*', (request) => ({
    id: request.params['*'],
    content: readScriptContent(ctx.location.paths.hooks, request.params['*']),
  }));

  app.put<{ Params: { '*': string }; Body: { content: string } }>('/api/scripts/*', (request) => ({
    ok: true,
    backupPath: saveScript(
      ctx.location.paths.hooks,
      request.params['*'],
      request.body.content,
      ctx.backupDir,
    ),
    needsRestart: true,
  }));

  app.post<{ Body: { name: string; content: string } }>('/api/scripts', (request) => ({
    ok: true,
    backupPath: saveScript(
      ctx.location.paths.hooks,
      request.body.name,
      request.body.content,
      ctx.backupDir,
    ),
    needsRestart: true,
  }));

  app.delete<{ Params: { '*': string } }>('/api/scripts/*', (request) => ({
    ok: true,
    backupPath: deleteScript(ctx.location.paths.hooks, request.params['*'], ctx.backupDir),
    needsRestart: true,
  }));
}
