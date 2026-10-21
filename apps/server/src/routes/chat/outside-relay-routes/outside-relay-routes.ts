import type { FastifyInstance } from 'fastify';
import {
  outsideAnswerSchema,
  outsideAskRegisterSchema,
  outsideMessageSendSchema,
  type OutsideRelayState,
} from '@agentdeck/contracts/chat-inbox';
import type { ServerContext } from '../../../context.ts';
import {
  RELAY_WAIT_MS,
  type OutsideRelay,
} from '../../../domains/chat/outside-relay/outside-relay.ts';
import {
  installRelayHooks,
  relayHookCommand,
  relayHooksStatus,
  uninstallRelayHooks,
  type RelayHooksStatus,
} from '../../../domains/chat/outside-relay/outside-relay-install.ts';
import { apiTokenPath } from '../../../lib/api-token/api-token.ts';

/** Самый короткий срез ожидания: хук между срезами смотрит, не ответили ли в окне. */
const MIN_WAIT_MS = 1_000;

/**
 * Сессии вне панели — под контролем с телефона. Хук панели регистрирует
 * вопрос или запрос прав и ждёт (`/wait` держит запрос срезами), телефон
 * решает; сообщения с телефона хук забирает после шага (`/messages/take`).
 * Хуки в настройках Claude Code следуют переключателю (`syncRelayHooks`):
 * владелец 11.10 — «из коробки», без ручной установки.
 */
/** Команда хука этой панели: адрес API и файл токена. */
export function panelRelayCommand(): string {
  return relayHookCommand(`http://127.0.0.1:${process.env.PORT ?? 5178}`, apiTokenPath());
}

/**
 * Хуки пересылки — по переключателю: включено — стоят, выключено — сняты.
 * Зовётся на старте панели и при каждом переключении. Сбой записи не валит
 * ни старт, ни запрос: настройки покажут «хука нет» и команду для «Хуков».
 * Каталога Claude нет (или ручной путь негоден) — не трогаем ничего: запись
 * хуков молча создала бы `~/.claude` у того, кто работает с другим CLI.
 */
export function syncRelayHooks(ctx: ServerContext): void {
  if (!ctx.location.isValid) return;
  const settings = ctx.location.paths.settings;
  try {
    if (ctx.store.getOutsideRelay()) {
      installRelayHooks(settings, ctx.store, panelRelayCommand(), ctx.backupDir);
    } else {
      uninstallRelayHooks(settings, ctx.store, ctx.backupDir);
    }
  } catch (error) {
    console.warn('outside relay: hooks sync failed', error);
  }
}

export function registerOutsideRelayRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  relay: OutsideRelay,
): void {
  // Настройки не читаются — хуков для телефона всё равно что нет: карточка
  // покажет команду, а не пропадёт вместе с ответом 500.
  const hooksStatus = (): RelayHooksStatus => {
    try {
      return relayHooksStatus(ctx.location.paths.settings, ctx.store);
    } catch {
      return { installed: false, shortTimeout: false };
    }
  };
  const state = (): OutsideRelayState => ({
    enabled: ctx.store.getOutsideRelay(),
    ...hooksStatus(),
    command: panelRelayCommand(),
  });

  app.get('/api/outside/relay', () => state());

  app.patch<{ Body: { enabled?: unknown } }>('/api/outside/relay', (req, reply) => {
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled' });
    ctx.store.setOutsideRelay(req.body.enabled);
    syncRelayHooks(ctx);
    return state();
  });

  app.post('/api/outside/asks', (req, reply) => {
    const parsed = outsideAskRegisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body' });
    return { intercept: relay.register(parsed.data) };
  });

  app.get<{ Params: { id: string }; Querystring: { ms?: string } }>(
    '/api/outside/asks/:id/wait',
    (req) => {
      const asked = Number(req.query.ms);
      const ms = Number.isFinite(asked)
        ? Math.min(Math.max(asked, MIN_WAIT_MS), RELAY_WAIT_MS)
        : RELAY_WAIT_MS;
      return relay.wait(req.params.id, ms);
    },
  );

  app.post<{ Params: { id: string } }>('/api/outside/asks/:id/answer', (req, reply) => {
    const parsed = outsideAnswerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body' });
    const decided = relay.decide(
      req.params.id,
      'answers' in parsed.data
        ? { state: 'answered', answers: parsed.data.answers }
        : { state: 'decided', behavior: parsed.data.behavior },
    );
    // Запроса уже нет — его решили в окне, отпустили или он истёк. Телефон
    // должен это сказать, а не сделать вид, что решение ушло.
    if (!decided) return reply.code(409).send({ error: 'gone' });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/outside/asks/:id/release', (req) => ({
    ok: relay.release(req.params.id),
  }));

  app.get<{ Querystring: { sessionId?: string } }>('/api/outside/messages', (req, reply) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return reply.code(400).send({ error: 'sessionId' });
    const { messages, hooked } = relay.listMessages(sessionId);
    return {
      hooked,
      messages: messages.map((message) => ({
        id: message.id,
        text: message.text,
        queuedAt: new Date(message.queuedAt).toISOString(),
        ...(message.deliveredAt !== undefined
          ? { deliveredAt: new Date(message.deliveredAt).toISOString() }
          : {}),
      })),
    };
  });

  app.post('/api/outside/messages', (req, reply) => {
    const parsed = outsideMessageSendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body' });
    // Выключено — хуки отпускают всё сразу, и сообщение молча ждало бы вечно.
    if (!ctx.store.getOutsideRelay()) return reply.code(409).send({ error: 'off' });
    return { id: relay.queue(parsed.data.sessionId, parsed.data.text).id };
  });

  app.post<{ Body: { sessionId?: unknown } }>('/api/outside/messages/take', (req, reply) => {
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      return reply.code(400).send({ error: 'sessionId' });
    }
    return { texts: relay.takeMessages(sessionId) };
  });
}
