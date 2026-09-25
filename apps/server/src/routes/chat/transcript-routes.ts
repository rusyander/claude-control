import { statSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { readChats, readChatMessages, findTranscript } from '../../domains/chat/ChatHistory.ts';
import { summarizedMessageIds } from '../../domains/platform/gateway/summarized-ledger.ts';
import { readChatProgress } from '../../domains/chat/ChatProgress.ts';
import { searchChats } from '../../domains/chat/ChatSearch.ts';
import { listProjects } from '../../domains/chat/ChatProjects.ts';
import { buildChatExport, type ExportFormat } from '../../domains/chat/ChatExport.ts';
import { createStepCost } from '../../domains/chat/ChatCost.ts';
import { pausedChatIds } from '../../domains/chat/tree-pause.ts';
import { conversationKeys } from '../../lib/app-store/chat-links.ts';
import type { SplitGroupStatus } from '../../lib/app-store/app-store.types.ts';
import { clampInt, DEFAULT_MESSAGE_PAGE, MAX_MESSAGE_PAGE } from '../../domains/chat/constants.ts';
import { sendConditional } from '../../lib/conditional-get.ts';
import { projectsDir } from './paths.ts';

/**
 * Группа в работе: идёт ход, ждёт человека или доводит фоновую команду.
 * Очередь (`pending`/`waiting`/`held`) и пауза — ещё или уже нет.
 */
const WORKING: ReadonlySet<SplitGroupStatus> = new Set(['started', 'awaiting', 'background']);

/** Список разговоров, поиск по ним и чтение самой переписки — только чтение. */
export function registerChatTranscriptRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  /** Жив ли процесс CLI разговора — от него зависит, жив ли его фон. */
  isProcessAlive: (chatId: string) => boolean = () => false,
  /** Ждёт ли разговор дерева человека — метка «ждёт вас» в списке. */
  awaitsYou: (chatId: string) => boolean = () => false,
): void {
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
   *
   * Ответ условный (ETag): список перечитывается на каждое событие наблюдателя
   * и по возврату в окно, а меняется реже, чем спрашивается.
   */
  app.get('/api/chats', (request, reply) => {
    const chats = readChats(projectsDir(ctx));
    const links = ctx.store.getChatLinks();
    // Разговоры деревьев на паузе — фишка в списке. Считается по записям паузы
    // и связям, а не по реестру: остановленный прогон из реестра УШЁЛ, и ничем
    // иным «стоит» от «молчит» в списке не отличить.
    const paused = pausedChatIds(ctx.store.getTreePauses(), links);
    // Звенья, снятые перезапуском групп: разговор остаётся под родителем, а не
    // всплывает корнем, но группой уже не числится — ни номера, ни стадии, только
    // метка `retired`. Имя группы остаётся: без него звено, чья первая реплика
    // целиком написана панелью, называлось первой репликой или именем проекта.
    const retired = ctx.store.getRetiredChatLinks();
    // Звено без своих слов (задание ревью, правок, доставки пишет панель) —
    // именем группы, а не заглушкой-проектом.
    const named = (chat: ChatSummary, groupTitle?: string) =>
      chat.untitled && groupTitle ? { title: groupTitle } : {};
    const withLinks =
      Object.keys(links).length === 0 && paused.size === 0 && Object.keys(retired).length === 0
        ? chats
        : chats.map((chat) => {
            const link = links[chat.id];
            const flag = paused.has(chat.id) ? { paused: true } : {};
            const old = link ? undefined : retired[chat.id];
            if (old) {
              // Группа прошлого разделения, пережившая новое (F5.2): приёмка и
              // неубранная копия — по чату, номер у неё от старого плана.
              const keys = conversationKeys(retired, chat.id);
              const kept = ctx.store
                .getSplitPlan(old.parentChatId)
                ?.retiredGroups?.find(
                  (item) => item.chatId && (item.chatId === chat.id || keys.includes(item.chatId)),
                );
              return {
                ...chat,
                ...flag,
                ...named(chat, old.title),
                parentId: old.parentChatId,
                retired: true,
                ...(kept?.acceptedAt ? { accepted: true } : {}),
                ...(kept?.path && !kept.cleaned ? { copyLeft: true } : {}),
                ...(old.title ? { groupTitle: old.title } : {}),
              };
            }
            if (!link) {
              // Родитель разделения — наверх списка, пока его группы в работе.
              const plan = ctx.store.getSplitPlan(chat.id);
              const working =
                !plan?.cancelledAt && plan?.groups.some((item) => WORKING.has(item.status));
              if (!working) return paused.has(chat.id) ? { ...chat, ...flag } : chat;
              return { ...chat, ...flag, inWork: true };
            }
            // Метки списка (итоговое ревью 25.09): без них ждущий ребёнок и
            // принятая группа читались в списке как просто молчащие чаты.
            const group =
              typeof link.groupIndex === 'number'
                ? ctx.store
                    .getSplitPlan(link.parentChatId)
                    ?.groups.find((item) => item.index === link.groupIndex)
                : undefined;
            // Группа помнит чат и черновым ключом `new-…`, если её цепочка ушла
            // в продолжение раньше, чем узнала настоящий id (живой прогон 25.09).
            const ownsGroup = (key: string | undefined): boolean =>
              key !== undefined &&
              (key === chat.id || conversationKeys(links, chat.id).includes(key));
            return {
              ...chat,
              ...flag,
              ...(awaitsYou(chat.id) ? { awaitsYou: true } : {}),
              ...(group?.acceptedAt && ownsGroup(group.chatId) ? { accepted: true } : {}),
              ...(group && ownsGroup(group.chatId) && WORKING.has(group.status)
                ? { inWork: true }
                : {}),
              // MR — у любого звена группы: он один на группу (владелец, 25.09).
              ...(group?.mr
                ? { mergeRequest: group.mr }
                : group?.deliver
                  ? { mergeRequestPending: true }
                  : {}),
              ...named(chat, link.title),
              parentId: link.parentChatId,
              // Ветка связи — только подпорка: она запомнена при заведении
              // копии, а транскрипт знает, где агент оказался после неё.
              ...(chat.branch || !link.branch ? {} : { branch: link.branch }),
              // Звено конвейера подбора модели. В транскрипте этого нет и быть
              // не может: «проверка работы соседнего чата» — понятие панели, а
              // без него три разговора одной группы выглядят в списке как три
              // независимых, и понять, который из них правит по замечаниям,
              // неоткуда.
              ...(link.stage ? { stage: link.stage } : {}),
              // Имя группы: у звеньев одной группы заголовки разные (текст их
              // первых сообщений), а группа у них одна, и в сводке у родителя
              // человек ищет глазами именно её.
              ...(link.title ? { groupTitle: link.title } : {}),
              // Номер группы — ключ строки хаба (Д12): ветку разговора агент
              // волен сменить, а группа от этого не становится другой.
              ...(typeof link.groupIndex === 'number' ? { groupIndex: link.groupIndex } : {}),
              // Назначенная модель — тоже подпорка, и по тому же правилу, что и
              // ветка: транскрипт знает, чем разговор ШЁЛ, а связь — чем панель
              // его завела. Пока ни одного ответа нет, второе единственное, что
              // есть: без него сводка звеньев у родителя молчит про модель
              // ровно в те минуты, когда на неё и смотрят.
              ...(chat.model || !link.model ? {} : { model: link.model }),
              // Назначенная глубина — только из связи: транскрипт её не пишет, и
              // без неё шапка разговора показывала бы глубину из настроек, а не
              // ту, на которой разговор идёт на самом деле.
              ...(link.effort ? { effort: link.effort } : {}),
              // Назначенная модель — отдельным полем и по тому же правилу, что
              // глубина: `model` выше — чем разговор шёл, а шапке нужно, чем
              // панель велела ему идти, чтобы следующее сообщение не уехало на
              // модели из настроек.
              ...(link.model ? { assignedModel: link.model } : {}),
              // Первая правка кода — только из связи: транскрипт этого не
              // считает, а по разнице с заведением ребёнка сводка у родителя
              // показывает, сколько ушло на обживание копии.
              ...(link.firstEditAt ? { firstEditAt: link.firstEditAt } : {}),
            };
          });
    return sendConditional(request, reply, withLinks);
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
  app.get('/api/chats/projects', (request, reply) =>
    sendConditional(request, reply, listProjects(projectsDir(ctx))),
  );

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
        // Подпись «контур сжал историю» — по журналу сжатий шлюза (`context-managed`).
        summarizedIds: summarizedMessageIds(ctx.location.paths.appData),
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
  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/progress', (request) => {
    const progress = readChatProgress(projectsDir(ctx), request.params.chatId);
    // Фон в транскрипте числится идущим и после смерти процесса: уведомление об
    // обрыве пишет только СЛЕДУЮЩИЙ процесс. Правду знает реестр.
    return { ...progress, processAlive: isProcessAlive(request.params.chatId) };
  });

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
        return reply
          .code(404)
          .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });

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
