import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ServerContext } from '../../../context.ts';
import {
  readChats,
  readChatMessages,
  findTranscript,
} from '../../../domains/chat/ChatHistory/ChatHistory.ts';
import { genTimesById } from '../../../domains/chat/gen-time-ledger/gen-time-ledger.ts';
import { readChatProgress } from '../../../domains/chat/ChatProgress/ChatProgress.ts';
import { searchChats } from '../../../domains/chat/ChatSearch/ChatSearch.ts';
import { listProjects } from '../../../domains/chat/ChatProjects/ChatProjects.ts';
import { buildChatExport, type ExportFormat } from '../../../domains/chat/ChatExport/ChatExport.ts';
import { createStepCost } from '../../../domains/chat/ChatCost/ChatCost.ts';
import { pausedChatIds } from '../../../domains/chat/tree-pause/tree-pause.ts';
import { conversationKeys } from '../../../lib/app-store/chat-links.ts';
import type { SplitGroupStatus } from '../../../lib/app-store/app-store.types.ts';
import {
  clampInt,
  DEFAULT_MESSAGE_PAGE,
  MAX_MESSAGE_PAGE,
} from '../../../domains/chat/constants.ts';
import { sendConditional } from '../../../lib/conditional-get/conditional-get.ts';
import { projectsDir } from '../paths.ts';
import { chatActiveMs } from '../../../domains/chat/chat-active-time/chat-active-time.ts';
import { createLimitShareReader } from '../../../domains/chat/limit-journal/limit-journal.ts';
import type { CoreChatHistory } from '../../../domains/chat/core-run/core-chat-history.ts';

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
  /**
   * Id сообщений, перед которыми контур сжал историю (`context-managed`), — журнал сжатий звена
   * ядра (C3b). Читатель не бросает: ядро молчит — пусто, лента без подписи, но не встаёт.
   */
  summarizedIds: () => Promise<Set<string>> = () => Promise.resolve(new Set()),
  /**
   * История разговоров не-Claude CLI из видов сеансов ядра (этап 11, волна 3): их транскрипта
   * панель не читает. Нет — такие разговоры живут только во вкладке, как было до волны 3.
   */
  coreHistory?: CoreChatHistory,
): void {
  // Тарифы достаёт слой маршрутов: кэш прайса и свои цены пользователя видны
  // только отсюда. Отдаём функцию, а не снимок, — правка цен подхватывается
  // следующим же запросом.
  const withStepCost = createStepCost(() => ({
    overrides: ctx.store.getSettings().modelPricing,
    entries: ctx.pricing.current().entries,
  }));
  // Доли окон лимита подписки по разговорам — из журнала прогонов, с памятью по
  // mtime: деление идёт по всем записям недели, а список спрашивают часто.
  const limitShares = createLimitShareReader(ctx.location.paths.appData);

  /**
   * Список разговоров. Транскрипты — источник правды по содержимому, но не по
   * происхождению: «этот чат выделен из того» знает только панель, и связь
   * приклеивается здесь, на выдаче. Отдельным запросом это делать нельзя —
   * дерево в списке рисуется сразу, а не вторым тактом.
   *
   * Ответ условный (ETag): список перечитывается на каждое событие наблюдателя
   * и по возврату в окно, а меняется реже, чем спрашивается.
   */
  app.get('/api/chats', async (request, reply) => {
    // Разговоры не-Claude CLI — сводками из ядра рядом со сводками транскриптов, тем же порядком.
    const foreign = coreHistory ? await coreHistory.summaries().catch(() => []) : [];
    const own = readChats(projectsDir(ctx));
    const chats =
      foreign.length === 0
        ? own
        : [...own, ...foreign.filter((chat) => !own.some((o) => o.id === chat.id))].sort((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt),
          );
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
    const shares = limitShares();
    const activeOf = (
      chat: ChatSummary,
      group: boolean,
    ): Pick<ChatSummary, 'activeMs' | 'limitShare'> => {
      if (!group || !chat.project) return {};
      const activeMs = chatActiveMs(join(projectsDir(ctx), chat.project, `${chat.id}.jsonl`));
      const limitShare = shares.get(chat.id);
      return {
        ...(activeMs === undefined ? {} : { activeMs }),
        ...(limitShare ? { limitShare } : {}),
      };
    };
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
              // Группе «нечего сдавать» MR не нужен — и «MR нет» не про неё.
              ...(group?.mr
                ? { mergeRequest: group.mr }
                : group?.deliver && group.result?.kind !== 'nothing'
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
              // Время работы звена группы — по транскрипту, без пауз и простоя;
              // доля окон лимита — по журналу прогонов. Только у групп: весь
              // транскрипт разбирается, а прочим связям карточки группы нет.
              ...activeOf(chat, typeof link.groupIndex === 'number'),
            };
          });
    // Закреплённые человеком — меткой на выдаче, как и связи: транскрипт о
    // закреплении не знает ничего.
    const pins = ctx.store.getChatPins();
    const withPins =
      Object.keys(pins).length === 0
        ? withLinks
        : withLinks.map((chat) => (pins[chat.id] ? { ...chat, pinnedAt: pins[chat.id] } : chat));
    // Ветка правки реплики — меткой на выдаче: её транскрипт несёт историю и
    // название исходного, и без метки в списке стояли два одинаковых чата.
    const forks = ctx.store.getChatForks();
    const titles = new Map(chats.map((chat) => [chat.id, chat.title]));
    const withForks =
      Object.keys(forks).length === 0
        ? withPins
        : withPins.map((chat) => {
            const origin = forks[chat.id];
            if (!origin) return chat;
            const title = titles.get(origin);
            return { ...chat, forkOf: { id: origin, ...(title ? { title } : {}) } };
          });
    return sendConditional(request, reply, withForks);
  });

  /**
   * Закрепить разговор в списке или открепить (владелец, 07.10.2026). Ветвь
   * разделения закрепляется своим корнем: ребёнка закрепить нельзя — он едет
   * вверх за родителем, а отдельно от него ветвь распалась бы.
   */
  app.put<{ Params: { chatId: string }; Body: unknown }>(
    '/api/chats/:chatId/pin',
    (request, reply) => {
      const body = request.body as { pinned?: unknown } | undefined;
      if (typeof body?.pinned !== 'boolean') {
        return reply
          .code(400)
          .send({ message: 'Нужно поле pinned: true или false', messageCode: 'chat-pin-invalid' });
      }
      const id = request.params.chatId;
      if (body.pinned && (ctx.store.getChatLink(id) || ctx.store.getRetiredChatLinks()[id])) {
        return reply.code(409).send({
          message: 'Чат группы закрепляется вместе со своим родителем',
          messageCode: 'chat-pin-child',
          code: 'chat_pin_child',
        });
      }
      ctx.store.setChatPin(id, body.pinned);
      return { id, pinned: body.pinned };
    },
  );

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
  app.get('/api/chats/projects', async (request, reply) => {
    // Разговоры не-Claude CLI — в своих проектах, как в `/api/chats`: по этому списку их находит телефон.
    const foreign = coreHistory ? await coreHistory.summaries().catch(() => []) : [];
    return sendConditional(request, reply, listProjects(projectsDir(ctx), foreign));
  });

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
      // Разговор не-Claude CLI транскрипта у панели не имеет — его лента из видов сеансов ядра.
      if (coreHistory && !findTranscript(projectsDir(ctx), request.params.chatId)) {
        const core = await coreHistory.messages(request.params.chatId, { limit, offset });
        if (core) return { ...core, messages: core.messages.map(withStepCost) };
      }
      const page = await readChatMessages(projectsDir(ctx), request.params.chatId, {
        limit,
        offset,
        // Подпись «контур сжал историю» — по журналу сжатий звена ядра (`context-managed`).
        summarizedIds: await summarizedIds().catch(() => new Set<string>()),
        // Скорость ответа локальной модели — по журналу времени генерации живого потока.
        genTimes: genTimesById(ctx.location.paths.appData),
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
  app.get<{ Params: { chatId: string } }>('/api/chats/:chatId/version', async (request) => {
    const path = findTranscript(projectsDir(ctx), request.params.chatId);
    if (!path) {
      // Разговор не-Claude CLI: отпечаток — стена последнего хода и байты вывода его сеансов.
      const core = await coreHistory?.version(request.params.chatId).catch(() => undefined);
      return core ?? { mtimeMs: 0, size: 0 };
    }

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
    // Субагенты — вызовы главного разговора; их дерево, модель, расход и фон — у ядра
    // («Агенты», `/api/core/agents`), транскрипты субагентов панель не читает (этап 11 W3-17).
    const progress = readChatProgress(projectsDir(ctx), request.params.chatId);
    // Фон в транскрипте числится идущим и после смерти процесса: уведомление об
    // обрыве пишет только СЛЕДУЮЩИЙ процесс. Правду знает реестр.
    return {
      ...progress,
      processAlive: isProcessAlive(request.params.chatId),
    };
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

      const all = { limit: Number.MAX_SAFE_INTEGER, offset: 0 };
      // Разговор не-Claude CLI выгружается из видов сеансов ядра, как его лента.
      const core = findTranscript(projectsDir(ctx), chatId)
        ? undefined
        : await coreHistory?.messages(chatId, all).catch(() => undefined);
      const page = core ?? (await readChatMessages(projectsDir(ctx), chatId, all));
      if (page.messages.length === 0)
        return reply
          .code(404)
          .send({ message: 'Разговор не найден', messageCode: 'conversation-not-found' });

      const listed =
        core && coreHistory
          ? await coreHistory.summaries().catch(() => [])
          : readChats(projectsDir(ctx));
      const title = listed.find((chat) => chat.id === chatId)?.title;
      const file = buildChatExport(page.messages, format, title);
      const safeId = chatId.replace(/[^a-zA-Z0-9-]/g, '') || 'chat';

      return reply
        .header('Content-Disposition', `attachment; filename="chat-${safeId}.${file.ext}"`)
        .type(file.mime)
        .send(file.content);
    },
  );
}
