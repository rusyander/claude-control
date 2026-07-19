import { join, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { readChats, readChatMessages } from '../domains/chat/ChatHistory.ts';
import { listProjects } from '../domains/chat/ChatProjects.ts';
import { listRoots, listDirectory } from '../domains/fs/FileBrowser.ts';
import { isEditorAvailable, openInEditor } from '../domains/fs/EditorLauncher.ts';
import { ChatRun, type ChatEvent } from '../domains/chat/ChatRunner.ts';
import {
  readArtifacts,
  readArtifactText,
  readArtifactBinary,
  chatDirectory,
} from '../domains/chat/ChatArtifacts.ts';
import { resolveWorkspace, permissionModeFor } from '../domains/chat/ChatWorkspace.ts';
import {
  saveUpload,
  isSupportedUpload,
  buildPromptWithFiles,
} from '../domains/chat/ChatUploads.ts';

/**
 * Маршруты чата. Ответ отдаётся потоком (SSE): пользователь видит текст по мере
 * генерации, как в самом Claude Code. Запущенные разговоры лежат в реестре,
 * чтобы их можно было остановить кнопкой.
 */
export function registerChatRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const running = new Map<string, ChatRun>();

  const projectsDir = join(ctx.location.paths.root, 'projects');

  app.get('/api/chats', () => readChats(projectsDir));

  /** Проекты, с которыми работал Claude Code, — для таба «Проекты» в чате. */
  app.get('/api/chats/projects', () => listProjects(projectsDir));

  /**
   * Каталог, в котором можно начать новый разговор проекта. Путь приходит от
   * клиента (пользователь выбрал проект из списка), поэтому подтверждаем, что
   * это существующий каталог: иначе Claude запустится не пойми где. Отсутствие
   * каталога не ошибка запроса — просто не переопределяем рабочую папку.
   */
  const validTargetCwd = (path: string | undefined): string | undefined => {
    if (!path || !isAbsolute(path)) return undefined;
    try {
      return statSync(path).isDirectory() ? path : undefined;
    } catch {
      return undefined;
    }
  };

  // --- Обзор файловой системы: выбор папки проекта ---

  app.get('/api/fs/roots', () => listRoots());

  app.get<{ Querystring: { path?: string } }>('/api/fs/list', (request, reply) => {
    const path = request.query.path;
    if (!path || !isAbsolute(path))
      return reply.code(400).send({ message: 'Нужен абсолютный путь' });
    try {
      return listDirectory(path);
    } catch {
      return reply.code(400).send({ message: 'Каталог недоступен' });
    }
  });

  // --- Открыть проект в VS Code ---

  app.post<{ Body: { path?: string } }>('/api/projects/open-in-editor', (request, reply) => {
    const path = validTargetCwd(request.body.path);
    if (!path) return reply.code(400).send({ message: 'Каталог не найден' });
    if (!isEditorAvailable()) {
      return reply.code(400).send({ message: 'VS Code не найден: команда code недоступна в PATH' });
    }
    openInEditor(path);
    return { ok: true };
  });

  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/messages', (request) =>
    readChatMessages(projectsDir, request.params.chatId),
  );

  app.post<{
    Body: {
      chatId: string;
      prompt: string;
      sessionId?: string;
      name?: string;
      fork?: boolean;
      files?: { name: string; base64: string }[];
      /** Разрешить правку файлов в настоящем проекте — тумблером из шапки. */
      allowEdits?: boolean;
      /** Каталог проекта для нового разговора — когда чат открыт из списка проектов. */
      projectPath?: string;
    };
  }>('/api/chat/send', { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const { chatId, prompt, sessionId, name, fork, files, allowEdits, projectPath } = request.body;

    // Разговор продолжается только из той папки, где он начинался. Для нового
    // чата, открытого из проекта, рабочей папкой становится каталог проекта.
    const workspace = resolveWorkspace(
      projectsDir,
      chatId,
      sessionId,
      true,
      validTargetCwd(projectPath),
    );

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (event: ChatEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    if (workspace.isMissing) {
      send({
        kind: 'error',
        message: `Рабочая папка этого чата не найдена: ${workspace.cwd}. Разговор начинался в ней, и продолжить его можно только оттуда.`,
      });
      reply.raw.end();
      return;
    }

    const cwd = workspace.cwd;

    // Вложения кладём в папку панели и перечисляем пути в промпте: Claude Code
    // читает файлы с диска сам, включая PDF и картинки. Именно в папку панели,
    // а не в рабочую: у разговора из настоящего проекта cwd — это каталог
    // проекта, и вложение осело бы прямо в рабочем дереве, попав затем в
    // ближайший `git add`. Промпт получает абсолютные пути, поэтому читаются
    // они одинаково откуда угодно.
    const uploadDir = workspace.isSandbox ? cwd : chatDirectory(chatId);
    const saved = (files ?? [])
      .filter((file) => isSupportedUpload(file.name))
      .map((file) => saveUpload(uploadDir, file.name, file.base64));

    const run = new ChatRun();
    running.set(chatId, run);

    // Пользователь может закрыть вкладку — процесс за ней тянуть незачем.
    // Следим именно за ответом: запрос закрывается сразу, как только дочитано
    // тело, и по нему разговор обрывался бы, не начавшись.
    reply.raw.on('close', () => {
      if (running.get(chatId) === run) {
        run.stop();
        running.delete(chatId);
      }
    });

    try {
      await run.start(
        {
          prompt: buildPromptWithFiles(prompt, saved),
          sessionId,
          name,
          fork,
          cwd,
          permissionMode: permissionModeFor(workspace, allowEdits),
        },
        send,
      );
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      running.delete(chatId);
      reply.raw.end();
    }
  });

  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/stop', (request) => {
    const run = running.get(request.params.chatId);
    run?.stop();
    return { ok: Boolean(run) };
  });

  /**
   * Артефакты показываем только у чатов песочницы. Разговор из настоящего
   * проекта работает в его каталоге, и вывалить весь репозиторий списком
   * «созданных файлов» было бы и бесполезно, и опасно.
   */
  const artifactDirectory = (chatId: string): string | undefined => {
    const workspace = resolveWorkspace(projectsDir, chatId, undefined, false);
    return workspace.isSandbox && !workspace.isMissing ? workspace.cwd : undefined;
  };

  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/artifacts', (request) => {
    const dir = artifactDirectory(request.params.chatId);
    return dir ? readArtifacts(dir) : [];
  });

  app.get<{ Params: { chatId: string }; Querystring: { name: string; as?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = artifactDirectory(request.params.chatId);
      if (!dir) return reply.code(404).send({ message: 'Файл не найден' });

      const { name, as } = request.query;

      // Картинки и PDF отдаём как файл — их встраивает сам браузер.
      if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(name)) {
        const binary = readArtifactBinary(dir, name);
        if (!binary) return reply.code(404).send({ message: 'Файл не найден' });

        return reply
          .type(name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*')
          .send(binary);
      }

      // Предпросмотр страницы: содержимое должно прийти разметкой, иначе
      // во врезке покажется JSON вместо самой страницы.
      if (as === 'html') {
        return (
          reply
            .type('text/html; charset=utf-8')
            // Страницу пишет модель — во врезке она изолирована, но и на уровне
            // ответа запрещаем ей тянуть что-либо из сети.
            .header(
              'Content-Security-Policy',
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:",
            )
            .send(readArtifactText(dir, name))
        );
      }

      return { name, content: readArtifactText(dir, name) };
    },
  );
}
