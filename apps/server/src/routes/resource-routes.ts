import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  listResourceFiles,
  readResourceFile,
  writeResourceFile,
  deleteResourceFile,
  moveResourceFile,
  isWritable,
} from '../domains/resources/ResourceFiles.ts';
import { layoutOf, type ResourceKind } from '../domains/resources/registry.ts';

/**
 * Файлы ресурсов — общие маршруты для всех видов.
 *
 * Вид передаётся в пути, а различия между скиллом, скриптом и плагином лежат
 * в реестре. Добавить работу с файлами для нового вида — значит дописать одну
 * запись в реестр, маршруты и интерфейс менять не нужно.
 */
export function registerResourceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  type Params = { kind: string; id: string };

  const kindOf = (params: Params): ResourceKind | undefined => layoutOf(params.kind)?.kind;

  app.get<{ Params: Params }>('/api/resources/:kind/:id/files', (request, reply) => {
    const kind = kindOf(request.params);
    if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

    return {
      files: listResourceFiles(kind, request.params.id, ctx.location),
      isWritable: isWritable(kind),
      entryFile: layoutOf(kind)?.entryFile,
    };
  });

  app.get<{ Params: Params; Querystring: { file: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      return {
        file: request.query.file,
        ...readResourceFile(kind, request.params.id, request.query.file, ctx.location),
      };
    },
  );

  app.put<{ Params: Params; Body: { file: string; content: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      try {
        writeResourceFile(
          kind,
          request.params.id,
          request.body.file,
          request.body.content,
          ctx.location,
          ctx.backupDir,
        );
        return { ok: true, needsRestart: true };
      } catch (error) {
        // Отказ по правам или выходу за границы — это ожидаемый ответ,
        // а не поломка сервера.
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );

  app.delete<{ Params: Params; Querystring: { file: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      try {
        deleteResourceFile(kind, request.params.id, request.query.file, ctx.location);
        return { ok: true, needsRestart: true };
      } catch (error) {
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );

  app.post<{ Params: Params; Body: { from: string; to: string } }>(
    '/api/resources/:kind/:id/move',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      try {
        moveResourceFile(kind, request.params.id, request.body.from, request.body.to, ctx.location);
        return { ok: true, needsRestart: true };
      } catch (error) {
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
