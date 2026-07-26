import type { FastifyInstance, FastifyReply } from 'fastify';
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
import { templatesFor, templateById } from '../domains/resources/templates.ts';
import { assistStructure } from '../domains/resources/ResourceAssistant.ts';
import { activeCliCommand } from '../providers/cli.ts';

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

  /**
   * Имя файла приходит из запроса и дальше идёт в `safePath`, где его сразу
   * тримят. Пропущенный параметр (`/file` без `?file=`) валил там TypeError:
   * маршрут чтения отвечал 500 с внутренним текстом, удаление — 400 с ним же.
   * Отсутствие имени — некорректный запрос, и сказать об этом надо словами.
   */
  const fileOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;

  const noFile = (reply: FastifyReply): FastifyReply =>
    reply.code(400).send({ message: 'Не указан файл' });

  // Заготовки структуры: начинать с пустого файла тяжело, а форма скилла
  // с модулями повторяется от скилла к скиллу.
  app.get<{ Params: { kind: string } }>('/api/resources/:kind/templates', (request) =>
    templatesFor(request.params.kind).map(({ id, title, description, files }) => ({
      id,
      title,
      description,
      fileCount: files.length,
      paths: files.map((file) => file.path),
    })),
  );

  /** Разворачивает шаблон в готовые файлы ресурса. */
  app.post<{ Params: Params; Body: { templateId: string } }>(
    '/api/resources/:kind/:id/apply-template',
    (request, reply) => {
      const kind = kindOf(request.params);
      const template = templateById(request.body.templateId);
      if (!kind || !template) return reply.code(404).send({ message: 'Шаблон не найден' });

      try {
        // Существующие файлы не трогаем: SKILL.md уже создан формой с введённым
        // именем и описанием — шаблон добавляет только недостающие модули.
        let created = 0;
        for (const file of template.files) {
          const before = readResourceFile(kind, request.params.id, file.path, ctx.location);
          if (before.content || before.isBinary) continue;

          writeResourceFile(
            kind,
            request.params.id,
            file.path,
            file.content,
            ctx.location,
            ctx.backupDir,
            true,
          );
          created += 1;
        }
        return { ok: true, created, needsRestart: true };
      } catch (error) {
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );

  /**
   * Помощник структуры: по описанию задачи собирает или дополняет файлы.
   * Применяет их сразу слиянием — существующее обновляется, новое добавляется,
   * ничего не удаляется само.
   */
  app.post<{ Params: Params; Body: { prompt: string; sessionId?: string } }>(
    '/api/resources/:kind/:id/assist',
    { bodyLimit: 4 * 1024 * 1024 },
    async (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      const result = await assistStructure(
        kind,
        request.params.id,
        request.body.prompt,
        ctx.location,
        activeCliCommand(ctx.store),
        request.body.sessionId,
      );

      if (result.error) return reply.code(400).send({ message: result.error });

      const applied: string[] = [];
      for (const file of result.files) {
        try {
          writeResourceFile(
            kind,
            request.params.id,
            file.path,
            file.content,
            ctx.location,
            ctx.backupDir,
          );
          applied.push(file.path);
        } catch {
          // Путь за границами ресурса — молча пропускаем этот файл, остальные
          // применяем: одна плохая строка не должна ронять весь ответ.
        }
      }

      return { reply: result.reply, applied, sessionId: result.sessionId };
    },
  );

  app.get<{ Params: Params }>('/api/resources/:kind/:id/files', (request, reply) => {
    const kind = kindOf(request.params);
    if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

    return {
      files: listResourceFiles(kind, request.params.id, ctx.location),
      isWritable: isWritable(kind),
      entryFile: layoutOf(kind)?.entryFile,
    };
  });

  app.get<{ Params: Params; Querystring: { file?: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      const file = fileOf(request.query.file);
      if (!file) return noFile(reply);

      return {
        file,
        ...readResourceFile(kind, request.params.id, file, ctx.location),
      };
    },
  );

  app.put<{ Params: Params; Body: { file?: string; content: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      const file = fileOf(request.body?.file);
      if (!file) return noFile(reply);

      try {
        writeResourceFile(
          kind,
          request.params.id,
          file,
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

  app.delete<{ Params: Params; Querystring: { file?: string } }>(
    '/api/resources/:kind/:id/file',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind) return reply.code(404).send({ message: 'Неизвестный вид ресурса' });

      const file = fileOf(request.query.file);
      if (!file) return noFile(reply);

      try {
        const backupPath = deleteResourceFile(
          kind,
          request.params.id,
          file,
          ctx.location,
          ctx.backupDir,
        );
        return { ok: true, needsRestart: true, backupPath };
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
