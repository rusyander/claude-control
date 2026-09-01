import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { readChats, readChatMessages, findTranscript } from '../../domains/chat/ChatHistory.ts';
import { readChatProgress } from '../../domains/chat/ChatProgress.ts';
import { searchChats } from '../../domains/chat/ChatSearch.ts';
import { listProjects } from '../../domains/chat/ChatProjects.ts';
import { buildChatExport, type ExportFormat } from '../../domains/chat/ChatExport.ts';
import { createStepCost } from '../../domains/chat/ChatCost.ts';
import { clampInt, DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE } from '../../domains/chat/constants.ts';
import { projectsDir } from './paths.ts';

/** Список разговоров, поиск по ним и чтение самой переписки — только чтение. */
export function registerChatTranscriptRoutes(app: FastifyInstance, ctx: ServerContext): void {
  // Тарифы достаёт слой маршрутов: кэш прайса и свои цены пользователя видны
  // только отсюда. Отдаём функцию, а не снимок, — правка цен подхватывается
  // следующим же запросом.
  const withStepCost = createStepCost(() => ({
    overrides: ctx.store.getSettings().modelPricing,
    entries: ctx.pricing.current().entries,
  }));

  /**
   * Список разговоров. Транскрипты — источник правды по содержимому, но не по
   * происхождению: «этот чат выделен из того» знает только панель, и связь
   * приклеивается здесь, на выдаче. Отдельным запросом это делать нельзя —
   * дерево в списке рисуется сразу, а не вторым тактом.
   */
  app.get('/api/chats', () => {
    const chats = readChats(projectsDir(ctx));
    const links = ctx.store.getChatLinks();
    if (Object.keys(links).length === 0) return chats;

    return chats.map((chat) => {
      const link = links[chat.id];
      if (!link) return chat;
      return {
        ...chat,
        parentId: link.parentChatId,
        ...(link.branch ? { branch: link.branch } : {}),
      };
    });
  });

  /**
   * Полнотекстовый поиск по телу переписки: в дополнение к фильтру списка по
   * заголовку/проекту/превью ищет по самим сообщениям и возвращает разговоры со
   * сниппетом вокруг совпадения. Читающий, без побочных эффектов; короткий
   * запрос отдаёт пустой результат, не читая диск.
   */
  app.get<{ Querystring: { q?: string } }>('/api/chat/search', (request) =>
    searchChats(projectsDir(ctx), request.query.q ?? ''),
  );

  /** Проекты, с которыми работал Claude Code, — для таба «Проекты» в чате. */
  app.get('/api/chats/projects', () => listProjects(projectsDir(ctx)));

  /**
   * Лента переписки окном. По умолчанию — последние сообщения; более ранние
   * подгружаются увеличением `limit` («Загрузить ещё»). Читается порциями, без
   * загрузки всего транскрипта в ответ.
   */
  app.get<{ Params: { chatId: string }; Querystring: { limit?: string; offset?: string } }>(
    '/api/chats/:chatId/messages',
    async (request) => {
      const limit = clampInt(request.query.limit, DEFAULT_MESSAGE_PAGE, 1, MAX_MESSAGE_PAGE);
      const offset = clampInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const page = await readChatMessages(projectsDir(ctx), request.params.chatId, {
        limit,
        offset,
      });
      return { ...page, messages: page.messages.map(withStepCost) };
    },
  );

  /**
   * Отпечаток транскрипта: изменился ли разговор с прошлого раза.
   *
   * Страховка к потоку `/api/events`: тот же разговор могут вести из терминала
   * или расширения редактора, наблюдатель за файлами бывает выключен тумблером,
   * а поток — оборван прокси. Опрашивать этой точкой дёшево (одна `stat`), в
   * отличие от самой ленты: ту приходится читать построчно целиком, а
   * транскрипт бывает стомегабайтным.
   *
   * Нет файла — нули: разговор ещё не начат, и это не ошибка.
   */
  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/version', (request) => {
    const path = findTranscript(projectsDir(ctx), request.params.chatId);
    if (!path) return { mtimeMs: 0, size: 0 };

    try {
      const stats = statSync(path);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      // Файл убрали между поиском и чтением — для опроса это просто «пусто».
      return { mtimeMs: 0, size: 0 };
    }
  });

  /**
   * Прогресс агента: чекпоинты его собственного плана и дерево субагентов.
   * Только чтение — план принадлежит агенту, панель его не правит.
   */
  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/progress', (request) =>
    readChatProgress(projectsDir(ctx), request.params.chatId),
  );

  /**
   * Выгрузка разговора файлом — Markdown или JSON. Собирается из всей переписки
   * (роли, время, текст); служебное и вложения-картинки в файл не тащим.
   */
  app.get<{ Params: { chatId: string }; Querystring: { format?: string } }>(
    '/api/chat/:chatId/export',
    async (request, reply) => {
      const { chatId } = request.params;
      const format: ExportFormat = request.query.format === 'json' ? 'json' : 'md';

      const page = await readChatMessages(projectsDir(ctx), chatId, {
        limit: Number.MAX_SAFE_INTEGER,
      });
      if (page.messages.length === 0)
        return reply.code(404).send({ message: 'Разговор не найден' });

      const title = readChats(projectsDir(ctx)).find((chat) => chat.id === chatId)?.title;
      const file = buildChatExport(page.messages, format, title);
      const safeId = chatId.replace(/[^a-zA-Z0-9-]/g, '') || 'chat';

      return reply
        .header('Content-Disposition', `attachment; filename="chat-${safeId}.${file.ext}"`)
        .type(file.mime)
        .send(file.content);
    },
  );
}
