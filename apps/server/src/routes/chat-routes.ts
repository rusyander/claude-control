import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { readChats, readChatMessages } from '../domains/chat/ChatHistory.ts';
import { ChatRun, type ChatEvent } from '../domains/chat/ChatRunner.ts';
import {
  readArtifacts,
  readArtifactText,
  readArtifactBinary,
  chatDirectory,
  renameChatDirectory,
} from '../domains/chat/ChatArtifacts.ts';
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
    };
  }>('/api/chat/send', { bodyLimit: 64 * 1024 * 1024 }, async (request, reply) => {
    const { chatId, prompt, sessionId, name, fork, files } = request.body;
    const cwd = chatDirectory(chatId);

    // Вложения кладём в папку чата и перечисляем пути в промпте: Claude Code
    // читает файлы с диска сам, включая PDF и картинки.
    const saved = (files ?? [])
      .filter((file) => isSupportedUpload(file.name))
      .map((file) => saveUpload(cwd, file.name, file.base64));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let realSessionId: string | undefined;

    const send = (event: ChatEvent): void => {
      if (event.kind === 'session') realSessionId = event.sessionId;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

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
        { prompt: buildPromptWithFiles(prompt, saved), sessionId, name, fork, cwd },
        send,
      );
    } catch (error) {
      send({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      running.delete(chatId);

      // Папку нового чата переносим под выданный идентификатор сессии — под ним
      // чат появится в списке, и артефакты должны лежать там же. Делаем это
      // после завершения: пока процесс работал, папка была его рабочей.
      if (realSessionId && chatId !== realSessionId) {
        try {
          renameChatDirectory(chatId, realSessionId);
        } catch {
          // Не смогли перенести — файлы останутся на месте, разговор не рвём.
        }
      }

      reply.raw.end();
    }
  });

  app.post<{ Params: { chatId: string } }>('/api/chat/:chatId/stop', (request) => {
    const run = running.get(request.params.chatId);
    run?.stop();
    return { ok: Boolean(run) };
  });

  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/artifacts', (request) =>
    readArtifacts(chatDirectory(request.params.chatId)),
  );

  app.get<{ Params: { chatId: string }; Querystring: { name: string; as?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = chatDirectory(request.params.chatId);
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
