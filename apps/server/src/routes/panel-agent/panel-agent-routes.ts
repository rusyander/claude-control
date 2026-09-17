import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  PanelActionJournalEntry,
  PanelActionOutcome,
  PanelActionResult,
  PanelActionsList,
  PanelPageTarget,
  PanelTextCode,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import type { ServerContext } from '../../context.ts';
import type { EventHub } from '../../lib/event-hub.ts';
import { isValidApiToken } from '../../lib/api-token.ts';
import { parseBody } from '../../lib/request-body.ts';
import { appendAgentJournal, readAgentJournal } from '../../domains/panel-agent/journal.ts';
import { readPanelAgentConversation } from '../../domains/panel-agent/conversations.ts';
import type { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { createRouteInjector, type InjectAccess } from './executor.ts';
import { PANEL_ACTIONS } from './actions.ts';
import { describeAction, type AnyPanelAction, type InjectRoute } from './registry.ts';
import { panelTextRu } from './texts.ts';
import { registerPanelHelpRoutes } from './help-routes.ts';

export interface PanelAgentRouteDeps {
  hub: EventHub;
  /** Ждущие карточки живут дольше запроса — их держит runtime. */
  pending: PanelPendingActions;
  access: InjectAccess & {
    /** Источники своего интерфейса: решение по карточке принимается только оттуда. */
    allowedOrigins: Set<string>;
  };
  /** Подмена набора — для тестов реестра; по умолчанию стартовый набор. */
  actions?: readonly AnyPanelAction[];
  /** Каталог исходников веба со справкой; по умолчанию соседний apps/web/src. */
  helpWebSrc?: string;
}

const callSchema = z.object({
  input: z.unknown().optional(),
  conversationId: z.string().max(200).optional(),
});

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

/**
 * Агент панели на сервере (А1): список действий, вызов, ждущие карточки,
 * решение человека и след.
 *
 * Отказ человека, таймаут, неверный вход и неизвестное действие отвечают 200 с
 * исходом, а не HTTP-ошибкой: переходник превращает исход в обычное предложение
 * для модели, и «человек отклонил» не должно выглядеть для неё как сломанный
 * инструмент, который стоит попробовать ещё раз.
 */
export function registerPanelAgentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deps: PanelAgentRouteDeps,
): void {
  const actions = deps.actions ?? PANEL_ACTIONS;
  const byName = new Map(actions.map((action) => [action.name, action]));
  const inject: InjectRoute = createRouteInjector(app, deps.access);
  // Каталог данных читается на каждую запись: он меняется на лету (`ctx.relocate`).
  const journal = (entry: PanelActionJournalEntry): void => {
    appendAgentJournal(ctx.location.paths.appData, entry);
  };

  registerPanelHelpRoutes(app, ctx, deps.helpWebSrc);

  app.get('/api/agent/actions', (): PanelActionsList => ({ actions: actions.map(describeAction) }));

  app.post<{ Params: { name: string }; Body: unknown }>(
    '/api/agent/actions/:name',
    async (request, reply): Promise<PanelActionResult> => {
      const action = byName.get(request.params.name);
      if (!action) {
        return { outcome: 'unknown', message: `No panel action named "${request.params.name}".` };
      }

      const call = callSchema.safeParse(request.body);
      const conversationId = call.success ? call.data.conversationId : undefined;
      const parsed = call.success
        ? action.input.safeParse(call.data.input ?? {})
        : { success: false as const, error: call.error };
      const base = {
        name: action.name,
        risk: action.risk,
        ...(conversationId ? { conversationId } : {}),
      };

      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || '(input)'}: ${issue.message}`)
          .join('; ');
        journal({
          ...base,
          at: new Date().toISOString(),
          outcome: 'invalid',
          decidedBy: 'auto',
          summary: panelTextRu('journal-invalid-input'),
          summaryCode: 'journal-invalid-input',
        });
        return { outcome: 'invalid', message };
      }
      const input = parsed.data;

      if (action.risk === 'read') {
        const result = await execute(action, input, conversationId);
        journal({
          ...base,
          at: new Date().toISOString(),
          outcome: result.outcome,
          decidedBy: 'auto',
          ...(result.status === undefined ? {} : { status: result.status }),
          ...(action.summary
            ? { summary: panelTextRu(action.summary), summaryCode: action.summary }
            : { summary: action.name }),
        });
        return result;
      }

      let preview;
      let fingerprint: string | undefined;
      try {
        // Отпечаток — ДО предпросмотра: правка между ними даст ложное «устарело»
        // (безопасно), а отпечаток после показа мог бы молча принять правку,
        // которой в карточке нет.
        fingerprint = action.fingerprint ? await action.fingerprint(input, inject) : undefined;
        preview = action.preview
          ? await action.preview(input, inject)
          : { summary: action.name, fields: [] };
      } catch (error) {
        return { outcome: 'failed', message: messageOf(error) };
      }

      const handle = deps.pending.create({
        name: action.name,
        risk: action.risk,
        ...(conversationId ? { conversationId } : {}),
        preview,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      // Переходник ушёл (агента остановили, окно закрыли) — карточка снимается:
      // выполнить действие, об исходе которого никто не узнает, хуже, чем не
      // выполнить. Слушаем ответ, а не запрос: у POST событие `close` запроса
      // приходит сразу после чтения тела.
      watchDisconnect(reply, () => deps.pending.cancel(handle.pending.id));
      deps.hub.emit({ type: 'agent-pending', pending: handle.pending });

      const settlement = await handle.settled;
      let result: PanelActionResult;
      if (settlement === 'approve') {
        result =
          (await staleness(action, input, handle.fingerprint)) ??
          (await execute(action, input, conversationId));
      } else if (settlement === 'reject')
        result = { outcome: 'rejected', message: 'Rejected by the human.' };
      else if (settlement === 'timeout')
        result = { outcome: 'timeout', message: 'The human did not answer in time.' };
      else result = { outcome: 'cancelled', message: 'The call was cancelled.' };

      const code = result.messageCode ? { messageCode: result.messageCode } : {};
      deps.hub.emit({
        type: 'agent-decided',
        id: handle.pending.id,
        outcome: result.outcome,
        ...code,
        section: action.section,
      });
      journal({
        ...base,
        at: new Date().toISOString(),
        outcome: result.outcome,
        decidedBy: decidedByOf(settlement),
        ...(result.status === undefined ? {} : { status: result.status }),
        ...code,
        // Название действия и факты исхода, но не сводка карточки: она собрана из
        // строк модели (заголовок правила, шаблон права, промпт).
        ...journalSummary(action, preview, result),
      });
      return result;
    },
  );

  app.get('/api/agent/pending', () => deps.pending.list());

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/agent/pending/:id',
    (request, reply) => {
      // Агент не подтверждает сам себя: пометка переходника и отсутствие своего
      // Origin отказывают ДО поиска карточки, чтобы отказ не выдавал, есть ли она.
      // compromise: agent-header-forgeable — локальный процесс того же пользователя подделает оба заголовка
      // (и прочтёт файл токена, когда удалённый доступ включён)
      const origin = request.headers.origin;
      const fromOwnWindow = typeof origin === 'string' && deps.access.allowedOrigins.has(origin);
      // Телефон — связанное устройство владельца: Origin у него нет, зато есть
      // токен панели в заголовке. Путь открыт только при включённом удалённом
      // доступе (без него токен не спрашивали и связывать нечего) и только
      // заголовком: `?token=` здесь не принимается. Процессу агента токен не
      // передаётся (белый список окружения), а пометка агента побеждает всегда.
      const authorization = request.headers.authorization;
      const bearer =
        typeof authorization === 'string' && authorization.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length).trim()
          : undefined;
      const fromPairedDevice =
        origin === undefined &&
        deps.access.requiresToken() &&
        isValidApiToken(bearer, deps.access.expectedToken());
      if (
        request.headers[PANEL_AGENT_HEADER] !== undefined ||
        !(fromOwnWindow || fromPairedDevice)
      ) {
        return reply.code(403).send({
          error: 'decision_not_allowed',
          message: 'Решение по карточке принимается только кликом в окне панели.',
        });
      }
      const body = parseBody(decisionSchema, request.body, reply);
      if (!body) return reply;

      // Карточка показала не всё, что выполнится, — одобрять нечего: человек
      // подтвердил бы невиденное. Отклонить её можно.
      const card = deps.pending.get(request.params.id);
      if (body.decision === 'approve' && card?.preview.truncated) {
        return reply.code(409).send({
          error: 'preview_truncated',
          message:
            'Карточка показывает не всё, что будет выполнено, — одобрить её нельзя. Отклоните и попросите агента разбить действие на части.',
        });
      }

      const verdict = deps.pending.decide(request.params.id, body.decision);
      if (verdict === 'not-found') {
        return reply
          .code(404)
          .send({ error: 'not_found', message: 'Такой карточки нет — возможно, она уже снята.' });
      }
      if (verdict === 'already-decided') {
        return reply
          .code(409)
          .send({ error: 'already_decided', message: 'По этой карточке уже принято решение.' });
      }
      return { ok: true };
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/api/agent/journal', (request) => {
    const limit = Number(request.query.limit);
    return readAgentJournal(
      ctx.location.paths.appData,
      Number.isFinite(limit) && limit > 0 ? limit : undefined,
    );
  });

  /**
   * Сверка отпечатка перед исполнением одобренной карточки. Не совпал или цель
   * уже не читается (удалена, маршрут отказал) — человек одобрял не это:
   * не выполняется ничего. Остаётся окно между сверкой и записью — оно в одном
   * процессе и без ожидания человека, а не минуты раздумий над карточкой.
   */
  async function staleness(
    action: AnyPanelAction,
    input: unknown,
    shown: string | undefined,
  ): Promise<PanelActionResult | undefined> {
    if (!action.fingerprint || shown === undefined) return undefined;
    let now: string | undefined;
    let reason = 'the target changed';
    try {
      now = await action.fingerprint(input, inject);
    } catch (error) {
      reason = `the target can no longer be read (${messageOf(error)})`;
    }
    if (now === shown) return undefined;
    return {
      outcome: 'failed',
      messageCode: 'stale_preview',
      message:
        `Not executed: ${reason} after the human saw the confirmation card, so the approval ` +
        `no longer matches what would be written. Nothing was changed. Read the current state ` +
        `and call ${action.name} again to show the human a fresh card.`,
    };
  }

  /** Выполнить действие и открыть страницу у человека, если оно этого просит. */
  async function execute(
    action: AnyPanelAction,
    input: unknown,
    conversationId: string | undefined,
  ): Promise<PanelActionResult> {
    let outcome: PanelActionOutcome;
    let payload: unknown;
    let status: number | undefined;
    try {
      if (action.local) {
        outcome = 'done';
        payload = action.local(input, {
          windows: deps.hub.size,
          pageContext: () =>
            conversationId
              ? readPanelAgentConversation(ctx.location.paths.appData, conversationId)?.context
              : undefined,
        });
      } else if (action.route) {
        const answer = await inject(await action.route(input, inject));
        status = answer.status;
        const refused = answer.status < 400 ? action.refusal?.(answer.body) : undefined;
        outcome = answer.status < 400 && refused === undefined ? 'done' : 'failed';
        let body = refused === undefined ? answer.body : { message: refused };
        if (outcome === 'done' && action.afterRoute) {
          try {
            body = await action.afterRoute(input, body, inject);
          } catch (error) {
            return { outcome: 'failed', status, message: messageOf(error) };
          }
        }
        payload = outcome === 'done' && action.shape ? action.shape(input, body) : body;
      } else {
        return { outcome: 'failed', message: 'Action has no executor.' };
      }
    } catch (error) {
      return { outcome: 'failed', message: messageOf(error) };
    }

    if (outcome === 'failed') {
      return {
        outcome,
        ...(status === undefined ? {} : { status }),
        message: routeMessage(payload, status),
      };
    }

    // Шаг секрета важнее обычной страницы: человек должен оказаться у поля
    // ключа, а не на общем списке.
    const secretPage = action.secretStep?.(input, payload);
    const page: PanelPageTarget | undefined = secretPage ?? action.page?.(input, payload);
    if (page) {
      deps.hub.emit({
        type: 'agent-open-page',
        page,
        ...(conversationId ? { conversationId } : {}),
      });
    }
    return {
      outcome: secretPage ? 'needs-secret' : outcome,
      result: payload,
      ...(status === undefined ? {} : { status }),
      ...(page ? { page } : {}),
      ...(secretPage
        ? {
            message:
              'Saved. A secret is needed next: its field is open on the human’s screen. ' +
              'You never see it; ask the human to enter it, then read the state again.',
          }
        : {}),
    };
  }
}

function watchDisconnect(reply: FastifyReply, onGone: () => void): void {
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) onGone();
  });
}

/**
 * Строка следа: название правки и факты исхода — русским запасным текстом и
 * кодами, которые окно переводит.
 */
function journalSummary(
  action: AnyPanelAction,
  preview: { diff?: string; truncated?: boolean },
  result: PanelActionResult,
): Pick<PanelActionJournalEntry, 'summary' | 'summaryCode' | 'summaryFacts'> {
  const facts: PanelTextCode[] = [
    ...(preview.diff ? (['fact-diff'] as const) : []),
    ...(preview.truncated ? (['fact-truncated'] as const) : []),
    ...(result.messageCode === 'stale_preview' ? (['fact-stale'] as const) : []),
  ];
  const title = action.title ? panelTextRu(action.title) : action.name;
  const text = facts.map((fact) => panelTextRu(fact)).join(', ');
  return {
    summary: facts.length > 0 ? `${title} — ${text}` : title,
    ...(action.title ? { summaryCode: action.title } : {}),
    ...(facts.length > 0 ? { summaryFacts: facts } : {}),
  };
}

function decidedByOf(settlement: string): PanelActionJournalEntry['decidedBy'] {
  if (settlement === 'timeout') return 'timeout';
  if (settlement === 'cancelled') return 'client';
  return 'human';
}

function routeMessage(body: unknown, status: number | undefined): string {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string') return record.error;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 500);
  return `HTTP ${status ?? '?'}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
