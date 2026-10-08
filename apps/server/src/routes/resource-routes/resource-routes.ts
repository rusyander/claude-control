import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  listResourceFiles,
  readResourceFile,
  writeResourceFile,
  deleteResourceFile,
  moveResourceFile,
  isWritable,
} from '../../domains/resources/ResourceFiles.ts';
import { layoutOf, type ResourceKind } from '../../domains/resources/registry.ts';
import { templatesFor, templateById } from '../../domains/resources/templates.ts';
import { assistStructure } from '../../domains/resources/ResourceAssistant.ts';
import { helperAskFor, type HelperRouteWiring } from '../../domains/assistant-route.ts';
import { readAgentImages } from '../../lib/agent-images/agent-images.ts';
import { assistHistorySchema, invalidAssistBody } from '../assistant-routes/assistant-routes.ts';

/**
 * Файлы ресурсов — общие маршруты для всех видов.
 *
 * Вид передаётся в пути, а различия между скиллом, скриптом и плагином лежат
 * в реестре. Добавить работу с файлами для нового вида — значит дописать одну
 * запись в реестр, маршруты и интерфейс менять не нужно.
 */
export function registerResourceRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  /** Маршрут провайдера для помощника структуры — тот же, что у помощника формы. */
  helperRoute: HelperRouteWiring,
): void {
  type Params = { kind: string; id: string };

  const kindOf = (params: Params): ResourceKind | undefined => layoutOf(params.kind)?.kind;

  // Писать здесь можно только файлы скиллов и папки hooks/: скиллы Claude Code
  // перечитывает на лету, скрипт хука запускается заново на каждое событие.
  // «Нужен перезапуск» было бы неправдой (как у `live()` в маршрутах скиллов);
  // плагин, правило и MCP через эти маршруты не пишутся вовсе (`isWritable`).
  const needsRestart = false;

  /**
   * Имя файла приходит из запроса и дальше идёт в `safePath`, где его сразу
   * тримят. Пропущенный параметр (`/file` без `?file=`) валил там TypeError:
   * маршрут чтения отвечал 500 с внутренним текстом, удаление — 400 с ним же.
   * Отсутствие имени — некорректный запрос, и сказать об этом надо словами.
   */
  const fileOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;

  const noFile = (reply: FastifyReply): FastifyReply =>
    reply.code(400).send({ message: 'Не указан файл', messageCode: 'resource-file-unspecified' });

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
      if (!kind || !template)
        return reply
          .code(404)
          .send({ message: 'Шаблон не найден', messageCode: 'resource-template-not-found' });

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
        return { ok: true, created, needsRestart };
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
  app.post<{ Params: Params; Body: { prompt: string; history?: unknown; images?: unknown } }>(
    '/api/resources/:kind/:id/assist',
    // Картинки (до восьми по 3,75 МБ в base64) — предел как у помощника формы.
    { bodyLimit: 48 * 1024 * 1024 },
    async (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind)
        return reply
          .code(404)
          .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });
      const images = readAgentImages(request.body?.images);
      if (!images.ok) return reply.code(400).send(images.refusal);
      // Сессии у помощника нет (лёгкое окно): разговор — прежними репликами в теле.
      const history = assistHistorySchema.safeParse(request.body?.history ?? []);
      if (!history.success) return reply.code(400).send(invalidAssistBody(history.error));

      const result = await assistStructure(
        kind,
        request.params.id,
        request.body.prompt,
        ctx.location,
        helperAskFor(ctx.store, ctx.location.paths.appData, helperRoute),
        history.data,
        images.images,
      );

      // Код причины едет рядом с текстом: отказ маршрута провайдера клиент
      // называет на своём языке, а не русской строкой сервера.
      if (result.error) {
        return reply.code(400).send({
          message: result.error,
          ...(result.messageCode ? { messageCode: result.messageCode } : {}),
          ...(result.params ? { params: result.params } : {}),
        });
      }

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

      // Файлы с секретом, который модель видела маской и не вернула на место, не
      // записаны: окно называет их, иначе человек не узнал бы, почему файла нет.
      return { reply: result.reply, applied, ...(result.kept ? { kept: result.kept } : {}) };
    },
  );

  app.get<{ Params: Params }>('/api/resources/:kind/:id/files', (request, reply) => {
    const kind = kindOf(request.params);
    if (!kind)
      return reply
        .code(404)
        .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });

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
      if (!kind)
        return reply
          .code(404)
          .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });

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
      if (!kind)
        return reply
          .code(404)
          .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });

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
        return { ok: true, needsRestart };
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
      if (!kind)
        return reply
          .code(404)
          .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });

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
        return { ok: true, needsRestart, backupPath };
      } catch (error) {
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );

  app.post<{ Params: Params; Body: { from: string; to: string } }>(
    '/api/resources/:kind/:id/move',
    (request, reply) => {
      const kind = kindOf(request.params);
      if (!kind)
        return reply
          .code(404)
          .send({ message: 'Неизвестный вид ресурса', messageCode: 'resource-kind-unknown' });

      try {
        moveResourceFile(kind, request.params.id, request.body.from, request.body.to, ctx.location);
        return { ok: true, needsRestart };
      } catch (error) {
        return reply.code(400).send({ message: messageOf(error) });
      }
    },
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
