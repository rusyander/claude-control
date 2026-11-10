import { basename } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import type { TelegramCoreBindingView } from '@agentdeck/contracts/core/telegram-channel';
import type { DeferredAskState } from '@agentdeck/contracts/deferred-asks';
import {
  telegramAnswersSaveSchema,
  type TelegramAnswersView,
} from '@agentdeck/contracts/telegram-answers';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import type { DeferredAsks } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import { readToken } from '../../domains/integrations/store/store.ts';
import {
  applyAnswer,
  sendChatText,
  type Inject,
} from '../../domains/notify/telegram-answers/apply.ts';
import { collectPendingAsks } from '../../domains/notify/telegram-answers/collect.ts';
import {
  createCoreAskButtons,
  type CoreAskButtons,
} from '../../domains/notify/telegram-answers/core-asks-runtime.ts';
import { agentBotIds } from '../../domains/notify/telegram-answers/same-bot.ts';
import { limitSharesOf } from '../../domains/notify/telegram-answers/commands.ts';
import { ConnectWindow } from '../../domains/notify/telegram-answers/connect.ts';
import { SentLog } from '../../domains/notify/telegram-answers/sent-log.ts';
import { TelegramAnswersService } from '../../domains/notify/telegram-answers/service.ts';
import { createTelegramNotices } from '../../domains/notify/telegram-notices/index.ts';
import { coreHomeOf } from '../../lib/hop-recorder.mjs';
import type { TelegramAnswersCover } from '../../domains/notify/telegram.ts';
import { AnswersStore } from '../../domains/notify/telegram-answers/store.ts';
import type {
  AskTarget,
  Vanished,
} from '../../domains/notify/telegram-answers/telegram-answers.types.ts';
import { readApiToken } from '../../lib/api-token/api-token.ts';
import {
  clearStoredKey,
  getStoredKey,
  maskKey,
  setStoredKey,
} from '../../lib/provider-keys/provider-keys.ts';
import { parseBody } from '../../lib/request-body.ts';
import { getProvider } from '../../providers/registry.ts';
import { deferredAsksOf } from '../chat/deferred-routes/deferred-store.ts';
import { isCorePermitCard } from '../chat/run-routes/run-routes.ts';
import { registerTelegramConnectRoutes } from './telegram-connect-routes.ts';

/**
 * Ответы из Telegram: настройка (`GET`/`PUT`), перезапуск опроса и сам опрос,
 * живущий, пока живёт сервер.
 *
 * Маршрута, который ПРИНИМАЕТ ответ из Telegram, нет и не будет: ответы
 * приходят только опросом бота (`getUpdates`) и проходят проверку владельца и
 * подписи кнопки. Любой локальный адрес «ответить за Telegram» был бы обходом
 * этих проверок.
 *
 * Токен отдельного бота хранится зашифрованным под `int:telegram-answers` и
 * наружу уходит только маской.
 */

const ANSWERS_TOKEN_ID = 'int:telegram-answers';

/** Решённые человеком состояния D-n: ответ дан в окне или на телефоне, не в этом сообщении. */
const DECIDED = new Set<DeferredAskState>(['allowed', 'denied', 'consumed']);

/**
 * D-n пропал из сводки (или нажатие опоздало): решён человеком — «Отвечено в
 * панели»; истёк, отозван или убран — «Уже не актуально». Истёкший тоже решить
 * можно заново, но ответа на него не было — сказать «отвечено» было бы ложью
 * (холодное ревью 23.10, D-L04).
 */
export function deferredVanished(asks: Pick<DeferredAsks, 'get'>, id: string): Vanished {
  const state = asks.get(id)?.state;
  return state && DECIDED.has(state) ? { kind: 'inPanel' } : { kind: 'stale' };
}

/**
 * Карточка прав пропала из сводки (или нажатие опоздало): ответили в окне или ушла.
 * Вопрос права задачи ядра сводка Telegram не берёт вовсе, но он ЖДЁТ — старое сообщение о нём
 * закрывается «ответ ядру — в панели или с телефона», а не «уже не актуально».
 */
export function permissionVanished(
  session: Pick<ChatSession, 'wasPermissionAnswered' | 'pendingPermissions'>,
  runKey: string,
  toolUseId: string,
): Vanished {
  if (session.wasPermissionAnswered(runKey, toolUseId)) return { kind: 'inPanel' };
  if (isCorePermitCard(session.pendingPermissions(), toolUseId)) return { kind: 'coreOnly' };
  return { kind: 'stale' };
}

export interface TelegramAnswersRouteDeps {
  registry: ChatRunRegistry;
  session: ChatSession;
  /** Куда опрос подставляет «права и вопросы доставляю я» (уведомления молчат). */
  cover?: TelegramAnswersCover;
  /** Имя чата по ключу прогона — для `/status`. */
  chatTitle?: (chatId: string) => string | undefined;
  /**
   * Кнопки вопросов ядра; `null` — выключены. Не задано — настоящие, кроме прогона vitest: тесты
   * подставляют свои, настоящее ядро машины им не трогать.
   */
  coreAsks?: CoreAskButtons | null;
}

/** Кнопки вопросов ядра для опроса: подмена теста, выключено под vitest или настоящие. */
function coreAskButtonsOf(
  deps: TelegramAnswersRouteDeps,
  real: () => CoreAskButtons,
): CoreAskButtons | null {
  if (deps.coreAsks !== undefined) return deps.coreAsks;
  if (process.env.VITEST) return null;
  return real();
}

export function registerTelegramAnswersRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: TelegramAnswersRouteDeps,
): void {
  const appData = (): string => ctx.location.paths.appData;
  // Одна запись на сервер: её читают и опрос, и настройка. Смена каталога
  // конфигурации на ходу её не переносит — запись остаётся при каталоге данных,
  // с которым сервер поднялся.
  const answersStore = new AnswersStore(appData());
  const store = (): AnswersStore => answersStore;
  const dedicatedToken = (): string | undefined => getStoredKey(appData(), ANSWERS_TOKEN_ID);
  const notifyToken = (): string | undefined => readToken(appData(), 'telegram');

  /** Запрос внутри процесса — тем же маршрутом и с тем же входом, что у человека. */
  const inject: Inject = async (request) => {
    const auth = ctx.store.getSettings().remoteAccess.enabled
      ? { authorization: `Bearer ${readApiToken()}` }
      : undefined;
    const reply = await app.inject({
      method: request.method,
      url: request.url,
      ...(auth ? { headers: auth } : {}),
      ...(request.payload ? { payload: request.payload } : {}),
    });
    return { statusCode: reply.statusCode, body: reply.body };
  };

  // Вопросы ядра задач кнопками (этап 12, D29): книга вопросов и порт команд Telegram.
  const coreAsks = coreAskButtonsOf(deps, () =>
    createCoreAskButtons({
      home: () => coreHomeOf(),
      token: () => dedicatedToken() ?? notifyToken(),
      ownerId: () => answersStore.settings.ownerId,
    }),
  );
  /** Открытые вопросы ядра; ядро недоступно — их нет в этом круге, сводка панели идёт как есть. */
  const coreAskItems = async () => {
    if (!coreAsks) return [];
    try {
      await coreAsks.asks.refresh();
    } catch (error) {
      app.log.debug({ err: String(error) }, 'telegram answers: core asks');
    }
    return coreAsks.asks.items();
  };

  const vanished = (target: AskTarget): Vanished => {
    switch (target.kind) {
      case 'coreAsk':
        return coreAsks ? coreAsks.asks.vanished(target) : { kind: 'stale' };
      case 'permission':
        return permissionVanished(deps.session, target.runKey, target.toolUseId);
      case 'question':
        // Вопрос пропал, а разговор снова идёт — ответ ушёл из панели или телефона.
        return deps.registry.isRunning(target.runKey ?? target.chatId, target.sessionId)
          ? { kind: 'inPanel' }
          : { kind: 'stale' };
      case 'deferred':
        try {
          return deferredVanished(deferredAsksOf(ctx), target.id);
        } catch {
          return { kind: 'stale' };
        }
      default:
        return { kind: 'stale' };
    }
  };

  const agentBots = (): Set<string> => {
    const paths = ctx.location.paths;
    return agentBotIds(
      {
        mcpConfig: paths.mcpConfig,
        settings: paths.settings,
        settingsLocal: paths.settingsLocal,
        secretsEnv: paths.secretsEnv,
        configRoot: paths.root,
      },
      ctx.store.getProjects().map((project) => project.path),
    );
  };

  // Окно подключения по /start: бот карточки Telegram. Сервис ниже объявлен
  // позже, поэтому окно спрашивает его через замыкание.
  const connect = new ConnectWindow({
    token: notifyToken,
    agentBotIds: agentBots,
    serviceListens: (token) => service.listensTo(token),
    log: (message) => app.log.info(message),
  });

  /** Ответ из Telegram идёт маршрутами панели с параметрами прошлого хода. */
  const applyDeps = (clientId: string) => ({
    inject,
    clientId,
    runParams: (keys: readonly string[]) => {
      const latest = deps.registry.latestRunOf(keys);
      if (!latest) return undefined;
      const { model, effort, permissionMode } = latest.options;
      return {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      };
    },
  });

  // Номера сообщений бота и команд владельца — для /clear; тот же файл пишет
  // отправитель уведомлений (рантайм).
  const sentLog = new SentLog(appData());

  // Уведомления о задачах ядра (этап 12, D29) — крючки того же цикла getUpdates; нет — как прежде.
  const notices = createTelegramNotices({
    coreHome: () => coreHomeOf(),
    appData,
    log: (message) => app.log.info(message),
    token: () => dedicatedToken() ?? notifyToken(),
    ownerId: () => answersStore.settings.ownerId,
    settings: () => ctx.store.getSettings().integrations.telegram,
    covers: () => service.covers(),
  });

  const service: TelegramAnswersService = new TelegramAnswersService({
    store: store(),
    sentLog,
    ...(notices ? { notices } : {}),
    token: () => dedicatedToken() ?? notifyToken(),
    agentBotIds: agentBots,
    // Главный выключатель карточки Telegram гасит и ответы: «выключено» значит
    // «ничего не шлём и не слушаем».
    active: () => ctx.store.getSettings().integrations.telegram.enabled,
    intercept: (update) => connect.offer(update),
    running: async () => runningChats(),
    limits: async () => {
      const reply = await inject({ method: 'GET', url: '/api/usage-limits' });
      return reply.statusCode === 200 ? limitSharesOf(JSON.parse(reply.body)) : undefined;
    },
    collect: async () => {
      const reply = await inject({ method: 'GET', url: '/api/chat/inbox' });
      if (reply.statusCode !== 200) throw new Error(`inbox ${reply.statusCode}`);
      const inbox = JSON.parse(reply.body) as ChatInbox;
      const own = collectPendingAsks({
        inbox,
        defaultCli: getProvider('claude').name,
        titleOf: (chatId) => titled(chatId).title,
        parentOf: (chatId) => ctx.store.getChatLink(chatId)?.parentChatId,
      });
      return [...own, ...(await coreAskItems())];
    },
    apply: (target, answer, clientId) =>
      target.kind === 'coreAsk' && coreAsks
        ? // Новый ключ повтора после отказа ядра живёт в цели сообщения — файл ответов пишется.
          coreAsks.apply(target, answer).finally(() => answersStore.save())
        : applyAnswer(target, answer, applyDeps(clientId)),
    sendToChat: (route, text, files, clientId) =>
      sendChatText(route, text, files, applyDeps(clientId)),
    ...sendGrace(),
    vanished,
    log: (message) => app.log.info(message),
  });

  /** Идущие разговоры панели — строки `/status` (ход чужого CLI — задача ядра, его лента там). */
  const runningChats = () => {
    const own = deps.registry
      .active()
      .filter((run) => run.status === 'running')
      .map((run) => ({
        project: run.projectPath ? basename(run.projectPath) : '',
        ...titled(run.chatId),
        startedAt: run.startedAt,
      }));
    return own;
  };
  const titled = (chatId: string): { title?: string } => {
    try {
      const title = deps.chatTitle?.(chatId);
      return title ? { title } : {};
    } catch {
      return {};
    }
  };

  if (deps.cover) deps.cover.covers = () => service.covers();
  // Вопросы ядра кнопками: опрос жив и ядро признаёт чат бота владельцем — текст пересылки молчит.
  if (deps.cover) {
    deps.cover.coreButtons = () => service.covers() && (coreAsks?.asks.covers() ?? false);
  }
  // Строки потока ядра (пересылка, рантайм) — повод перечитать задачу для уведомлений.
  if (deps.cover) deps.cover.coreLine = (task, event) => notices.onLine(task, event);

  registerTelegramConnectRoutes(app, ctx, {
    connect,
    service,
    answers: answersStore,
    notifyToken,
    sentLog,
  });

  const view = (): TelegramAnswersView => {
    const answers = store();
    const settings = answers.settings;
    const dedicated = dedicatedToken();
    const notify = notifyToken();
    const notifyChat = ctx.store.getSettings().integrations.telegram.chatId.trim();
    return {
      settings,
      hasToken: Boolean(dedicated),
      maskedToken: dedicated ? maskKey(dedicated) : '',
      usesNotifyBot: !dedicated && Boolean(notify),
      // Личный чат с ботом: его id совпадает с id человека. Группа (минус) — нет.
      ...(!settings.ownerId && /^\d{1,20}$/.test(notifyChat)
        ? { suggestedOwnerId: notifyChat }
        : {}),
      status: service.status(),
      open: answers.openItems(),
    };
  };

  app.get('/api/integrations/telegram/answers', () => view());

  /**
   * Привязка ответов ядру (этап 12, D29): отпечаток чата бота ответов и признаёт ли его ядро. Запись
   * `telegram.owner` делает окно панели само — `set-config` ядра с доказательством страницы; сервер
   * её не пишет: строгая настройка ядра — только из браузера или с телефона.
   */
  app.get(
    '/api/integrations/telegram/answers/core-binding',
    async (): Promise<TelegramCoreBindingView> => {
      const settings = store().settings;
      const fingerprint = coreAsks?.fingerprint() ?? null;
      let bound = false;
      let reachable = coreAsks !== null;
      if (coreAsks && fingerprint) {
        try {
          await coreAsks.asks.refresh();
          bound = coreAsks.asks.covers();
        } catch {
          reachable = false;
        }
      }
      return {
        fingerprint,
        bound,
        reachable,
        ownerName: settings.ownerName,
        listening: service.covers(),
      };
    },
  );

  app.put<{ Body: unknown }>('/api/integrations/telegram/answers', async (request, reply) => {
    const body = parseBody(telegramAnswersSaveSchema, request.body, reply);
    if (!body) return reply;
    // Форму токена уже проверила схема; пустая строка стирает сохранённый.
    if (body.token === '') clearStoredKey(appData(), ANSWERS_TOKEN_ID);
    else if (body.token) setStoredKey(appData(), ANSWERS_TOKEN_ID, body.token);
    const answers = store();
    const current = answers.settings;
    const ownerId = body.ownerId ?? current.ownerId;
    answers.setSettings({
      enabled: body.enabled ?? current.enabled,
      afterMinutes: body.afterMinutes ?? current.afterMinutes,
      ownerId,
      // Имя из подтверждения /start — только своему id.
      ownerName: ownerId === current.ownerId ? current.ownerName : '',
    });
    await service.restart();
    return view();
  });

  app.post('/api/integrations/telegram/answers/restart', async () => {
    await service.restart();
    return view();
  });

  // Опрос — после готовности сервера: сводка ожиданий, которую он читает, —
  // тоже маршрут, и до `onReady` его ещё нет.
  app.addHook('onReady', async () => {
    void service
      .restart()
      .catch((error: unknown) =>
        app.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'telegram answers',
        ),
      );
  });
  // Бот карточки Telegram — бот ответов по умолчанию. Его токен сохранили,
  // сменили или забыли — опрос перезапускается: иначе он так и стоял бы в «нет
  // токена» или слушал прежнего бота до перезапуска панели (живой прогон 25.10).
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 300 || request.routeOptions.url !== '/api/integrations/:id') return;
    if (request.method !== 'PUT' && request.method !== 'DELETE') return;
    if ((request.params as { id?: string }).id !== 'telegram') return;
    if (!store().settings.enabled) return;
    void service
      .restart()
      .catch((error: unknown) =>
        app.log.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'telegram answers',
        ),
      );
  });

  app.addHook('onClose', async () => {
    service.stop();
    connect.cancel();
    notices.stop();
  });
}

/**
 * Тишина после старта и сна — две минуты; стенды QA и кадров справки задают её
 * переменной `AGENTDECK_TELEGRAM_SEND_GRACE_MS`, чтобы не ждать.
 */
function sendGrace(): { sendGraceMs?: number } {
  const raw = Number(process.env.AGENTDECK_TELEGRAM_SEND_GRACE_MS);
  return Number.isFinite(raw) && raw >= 0 && process.env.AGENTDECK_TELEGRAM_SEND_GRACE_MS
    ? { sendGraceMs: raw }
    : {};
}
