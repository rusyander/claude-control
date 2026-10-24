import type { FastifyInstance } from 'fastify';
import type { ChatInbox } from '@agentdeck/contracts/chat-inbox';
import type { DeferredAskState } from '@agentdeck/contracts/deferred-asks';
import {
  telegramAnswersSaveSchema,
  type TelegramAnswersView,
} from '@agentdeck/contracts/telegram-answers';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import type { DeferredAsks } from '../../domains/chat/deferred-asks/deferred-asks.ts';
import type { ProviderChatService } from '../../domains/provider-chat/ProviderChatService/ProviderChatService.ts';
import { readToken } from '../../domains/integrations/store/store.ts';
import { applyAnswer, type Inject } from '../../domains/notify/telegram-answers/apply.ts';
import { collectPendingAsks } from '../../domains/notify/telegram-answers/collect.ts';
import { agentBotIds } from '../../domains/notify/telegram-answers/same-bot.ts';
import { TelegramAnswersService } from '../../domains/notify/telegram-answers/service.ts';
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

export const ANSWERS_TOKEN_ID = 'int:telegram-answers';

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

export interface TelegramAnswersRouteDeps {
  registry: ChatRunRegistry;
  session: ChatSession;
  providerChats: ProviderChatService;
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

  const vanished = (target: AskTarget): Vanished => {
    switch (target.kind) {
      case 'permission':
      case 'branchGate': {
        if (deps.session.wasPermissionAnswered(target.runKey, target.toolUseId)) {
          return { kind: 'inPanel' };
        }
        const deferred = deferredIdOf(target.runKey, target.toolUseId);
        return deferred ? { kind: 'deferred', id: deferred } : { kind: 'stale' };
      }
      case 'question':
        // Вопрос пропал, а разговор снова идёт — ответ ушёл из панели или телефона.
        return deps.registry.isRunning(target.runKey ?? target.chatId, target.sessionId)
          ? { kind: 'inPanel' }
          : { kind: 'stale' };
      case 'foreign':
        return deps.providerChats.isChatRunning(target.chatId)
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

  const deferredIdOf = (runKey: string, toolUseId: string): string | undefined => {
    try {
      return deferredAsksOf(ctx).byToolUse([runKey], toolUseId)?.id;
    } catch {
      return undefined;
    }
  };

  const service = new TelegramAnswersService({
    store: store(),
    token: () => dedicatedToken() ?? notifyToken(),
    agentBotIds: () => {
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
    },
    collect: async () => {
      const reply = await inject({ method: 'GET', url: '/api/chat/inbox' });
      if (reply.statusCode !== 200) throw new Error(`inbox ${reply.statusCode}`);
      const inbox = JSON.parse(reply.body) as ChatInbox;
      return collectPendingAsks({
        inbox,
        foreign: deps.providerChats.pendingAsks(),
        defaultCli: getProvider('claude').name,
        cliName: (id) => {
          try {
            return getProvider(id).name;
          } catch {
            return id;
          }
        },
      });
    },
    apply: (target, answer, clientId) =>
      applyAnswer(target, answer, {
        inject,
        clientId,
        runParams: (keys) => {
          const latest = deps.registry.latestRunOf(keys);
          if (!latest) return undefined;
          const { model, effort, permissionMode } = latest.options;
          return {
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          };
        },
      }),
    vanished,
    log: (message) => app.log.info(message),
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

  app.put<{ Body: unknown }>('/api/integrations/telegram/answers', async (request, reply) => {
    const body = parseBody(telegramAnswersSaveSchema, request.body, reply);
    if (!body) return reply;
    // Форму токена уже проверила схема; пустая строка стирает сохранённый.
    if (body.token === '') clearStoredKey(appData(), ANSWERS_TOKEN_ID);
    else if (body.token) setStoredKey(appData(), ANSWERS_TOKEN_ID, body.token);
    const answers = store();
    const current = answers.settings;
    answers.setSettings({
      enabled: body.enabled ?? current.enabled,
      afterMinutes: body.afterMinutes ?? current.afterMinutes,
      ownerId: body.ownerId ?? current.ownerId,
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
  app.addHook('onClose', async () => service.stop());
}
