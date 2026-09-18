import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectCodeView } from '@agentdeck/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import { findTranscript, readTranscriptRecords } from '../domains/chat/ChatHistory.ts';
import { checkProjectDir } from '../domains/projects.ts';
import {
  ProjectFileError,
  StaleFileError,
  collectAgentEdits,
  listProjectDir,
  readProjectChanges,
  readProjectFile,
  readProjectMedia,
  saveProjectFile,
  type CollectedEdits,
} from '../domains/project-files.ts';
import { projectsDir } from './chat/paths.ts';
import { codeOf } from '../lib/server-text.ts';

/**
 * Файлы проекта, открытого в чате: дерево, содержимое с диффом правок агента и
 * запись.
 *
 * Каталог приходит путём, а не идентификатором реестра, — тот же уговор, что у
 * git проекта (`project-git-routes.ts`): вкладку можно открыть на любой папке,
 * выбранной в проводнике панели, и она в реестре не числится. Путь проходит ту
 * же проверку `checkProjectDir` и дальше идёт нормализованным.
 *
 * Разговор (`chatId`) нужен только диффу: он отвечает на вопрос «что поменял
 * агент ИМЕННО ЗДЕСЬ». Без него дерево и файлы читаются как обычно, просто без
 * сравнения — так раздел работает и в каталоге без git, и в новом разговоре.
 *
 * Склейка транскрипта с доменом живёт здесь намеренно: домен файлов о чате
 * ничего не знает, а домен чата — о проекте. Соединять их — работа маршрута.
 */
export function registerProjectFilesRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const requireRoot = (path: string | undefined, reply: FastifyReply): string | undefined => {
    const problem = checkProjectDir(String(path ?? ''));
    if (problem) {
      void reply.code(400).send({ message: problem });
      return undefined;
    }
    return resolve(path as string);
  };

  /**
   * Правки агента из транскрипта разговора.
   *
   * Транскрипт — файл на мегабайты, а открывают из дерева файл за файлом, и
   * каждый раз разбирать его заново значит держать интерфейс в ожидании на
   * ровном месте. Память маленькая (последние разговоры) и сама себя проверяет
   * по размеру и времени записи: транскрипт растёт с каждым ходом агента, так
   * что устаревший ответ здесь невозможен.
   */
  const editsCache = new Map<string, { mtimeMs: number; size: number; value: CollectedEdits }>();

  const editsOf = (root: string, chatId: string | undefined): CollectedEdits => {
    const empty: CollectedEdits = { byFile: new Map(), skipped: 0 };
    if (!chatId) return empty;

    const path = findTranscript(projectsDir(ctx), chatId);
    if (!path) return empty;

    let stats;
    try {
      stats = statSync(path);
    } catch {
      return empty;
    }

    const key = `${root}\u0000${path}`;
    const cached = editsCache.get(key);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.value;
    }

    const value = collectAgentEdits(root, readTranscriptRecords(path));
    // Больше горстки записей держать незачем: ходят по одному-двум разговорам.
    if (editsCache.size >= 4) editsCache.delete(editsCache.keys().next().value as string);
    editsCache.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    return value;
  };

  /** Отказ домена — это ответ 400 с его же текстом, а не пятисотка. */
  const failed = (error: unknown, reply: FastifyReply): FastifyReply | undefined => {
    if (error instanceof ProjectFileError) {
      return reply.code(400).send({ message: error.message, ...codeOf(error) });
    }
    if (error instanceof StaleFileError) {
      return reply.code(409).send({ message: error.message, ...codeOf(error) });
    }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return reply
        .code(404)
        .send({ message: 'Файл не найден.', messageCode: 'file-not-found-dot' });
    }
    return undefined;
  };

  /** Содержимое одного каталога проекта. Пустой `dir` — корень. */
  app.get<{ Querystring: { path?: string; dir?: string } }>(
    '/api/project-files/tree',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      try {
        return listProjectDir(root, String(request.query.dir ?? ''));
      } catch (error) {
        return (
          failed(error, reply) ??
          reply
            .code(400)
            .send({ message: 'Каталог недоступен.', messageCode: 'directory-unavailable-dot' })
        );
      }
    },
  );

  /** Какие файлы проекта тронул агент в этом разговоре и насколько. */
  app.get<{ Querystring: { path?: string; chatId?: string } }>(
    '/api/project-files/changes',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      return readProjectChanges(root, editsOf(root, request.query.chatId));
    },
  );

  /** Файл целиком: текущий текст, восстановленное «до» и счётчики. */
  app.get<{ Querystring: { path?: string; file?: string; chatId?: string } }>(
    '/api/project-files/content',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      const file = String(request.query.file ?? '');
      const edits = editsOf(root, request.query.chatId).byFile.get(file) ?? [];

      try {
        return readProjectFile(root, file, edits);
      } catch (error) {
        return (
          failed(error, reply) ??
          reply.code(400).send({ message: 'Файл недоступен.', messageCode: 'file-unavailable' })
        );
      }
    },
  );

  /**
   * Байты картинки или PDF — их браузер тянет сам, тегом.
   *
   * Отдельный маршрут, а не поле в `content`: гнать двоичный файл через JSON
   * значит раздуть его в base64 и лишить браузер собственного показа
   * (прогрессивная отрисовка, просмотрщик PDF, масштабирование).
   *
   * Тип содержимого приходит из закрытого списка домена, и в нём нет ни
   * `text/html`, ни `image/svg+xml`: адрес у панели общий, поэтому файл,
   * который браузер согласится ВЫПОЛНИТЬ, отдавать нельзя. `nosniff` закрывает
   * ту же дыру со стороны угадывания типа. Заголовка CSP здесь намеренно нет:
   * директива `sandbox` ломает встроенный просмотрщик PDF, а защищать ей
   * нечего — список типов и так закрыт.
   */
  app.get<{ Querystring: { path?: string; file?: string } }>(
    '/api/project-files/raw',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      try {
        const media = readProjectMedia(root, String(request.query.file ?? ''));
        return reply
          .type(media.mediaType)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'no-store')
          .send(media.bytes);
      } catch (error) {
        return (
          failed(error, reply) ??
          reply.code(400).send({ message: 'Файл недоступен.', messageCode: 'file-unavailable' })
        );
      }
    },
  );

  /**
   * Снимок окна кода у таба проекта: дерево, открытый файл, режимы показа.
   *
   * Хранится в состоянии панели, а не в браузере: у панели уже есть свой файл,
   * и запись в нём переживает чистку кэша и смену браузера. Пусто — таб
   * открывают впервые, умолчания расставит клиент.
   */
  app.get<{ Querystring: { path?: string } }>('/api/project-files/view', async (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;

    return ctx.store.getCodeView(root) ?? null;
  });

  app.put<{ Body: { path?: string; view?: ProjectCodeView } }>(
    '/api/project-files/view',
    async (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;

      const view = request.body?.view;
      if (!view || !Array.isArray(view.openDirs)) {
        return reply.code(400).send({
          message: 'Неполный снимок окна кода.',
          messageCode: 'code-window-snapshot-incomplete',
        });
      }

      ctx.store.setCodeView(root, {
        file: typeof view.file === 'string' ? view.file : undefined,
        openDirs: view.openDirs.filter((dir) => typeof dir === 'string'),
        showDiff: Boolean(view.showDiff),
        onlyChanged: Boolean(view.onlyChanged),
      });
      return { ok: true };
    },
  );

  /**
   * Раскладка окна — одна на панель, поэтому без `path`: ширину списка файлов
   * человек тащит под себя, а не под конкретный репозиторий.
   */
  app.get('/api/project-files/layout', async () => ctx.store.getCodeLayout());

  app.put<{ Body: { treeWidth?: number } }>('/api/project-files/layout', async (request, reply) => {
    const width = request.body?.treeWidth;
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      return reply.code(400).send({
        message: 'Ширина списка файлов не задана.',
        messageCode: 'file-list-width-missing',
      });
    }

    // Значение приходит из перетаскивания мышью — обрезаем по границам, а не
    // отказываем: попасть в них пикселем в пиксель не обязан никто.
    ctx.store.setCodeLayout({ treeWidth: width });
    return ctx.store.getCodeLayout();
  });

  /** Таб закрыли — снимок больше не нужен. */
  app.delete<{ Querystring: { path?: string } }>(
    '/api/project-files/view',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      ctx.store.forgetCodeView(root);
      return { ok: true };
    },
  );

  /**
   * Записать правку человека. Тело несёт `mtimeMs`, полученный при открытии:
   * им сверяется, не переписал ли файл кто-то ещё, пока его правили.
   */
  app.put<{
    Body: { path?: string; file?: string; content?: string; mtimeMs?: number };
  }>('/api/project-files/content', async (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;

    const { file, content, mtimeMs } = request.body;
    if (typeof file !== 'string' || typeof content !== 'string' || typeof mtimeMs !== 'number') {
      return reply
        .code(400)
        .send({ message: 'Неполный запрос на запись.', messageCode: 'write-request-incomplete' });
    }

    try {
      return saveProjectFile(root, file, content, mtimeMs, ctx.backupDir);
    } catch (error) {
      return (
        failed(error, reply) ??
        reply.code(400).send({ message: 'Записать не удалось.', messageCode: 'write-failed' })
      );
    }
  });
}
