import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { listRoots, listDirectory } from '../../domains/fs/FileBrowser.ts';
import {
  detectEditors,
  resolveEditorCommand,
  openInEditor,
} from '../../domains/fs/EditorLauncher.ts';
import { validTargetCwd } from './paths.ts';

/** Обзор файловой системы (выбор папки проекта) и открытие проекта во внешнем редакторе. */
export function registerChatBrowseRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/fs/roots', () => listRoots());

  app.get<{ Querystring: { path?: string; files?: string } }>('/api/fs/list', (request, reply) => {
    const path = request.query.path;
    if (!path || !isAbsolute(path))
      return reply.code(400).send({ message: 'Нужен абсолютный путь' });
    // `files=.zip,.json` — показать ещё и файлы с такими расширениями (выбор
    // архива переноса). Без параметра поведение прежнее: только каталоги.
    const fileExtensions = (request.query.files ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      return listDirectory(path, { fileExtensions });
    } catch {
      return reply.code(400).send({ message: 'Каталог недоступен' });
    }
  });

  /** Редакторы, установленные в системе, — для выбора в настройках. */
  app.get('/api/editors', () => detectEditors());

  app.post<{ Body: { path?: string; editor?: string } }>(
    '/api/projects/open-in-editor',
    (request, reply) => {
      const path = validTargetCwd(request.body.path);
      if (!path) return reply.code(400).send({ message: 'Каталог не найден' });

      // Явно заданный редактор → настроенный → первый найденный в системе.
      const command = resolveEditorCommand(request.body.editor || ctx.store.getSettings().editor);
      if (!command) {
        return reply.code(400).send({
          message: 'Редактор кода не найден. Укажите его в настройках или установите code/cursor.',
        });
      }

      openInEditor(path, command);
      return { ok: true, editor: command };
    },
  );
}
