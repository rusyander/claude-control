import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DlpApiKind } from '@agentdeck/dlp/api-shapes';
import type { AliasVault } from '@agentdeck/dlp/mask';
import { maskRequestBody } from '@agentdeck/dlp/request-filter';
import { maskingOn, rulesOf, upstreamAuth, upstreamUrl, type HopContext } from '../context.ts';
import type { HopTraceEntry, TagEntry } from '../host.types.ts';
import { clientGone, refuse, type Refusal } from '../http.ts';
import { callUpstream, retryAfterSeconds, UpstreamError, type UpstreamReply } from '../upstream.ts';
import type { HopDriver } from './drivers/driver.types.ts';
import { bridgeUpstreamStatus } from './status/status.ts';
import { hopText } from './texts.ts';

/**
 * Общее у моста и родной ручки шлюза: маска тела наверх, поход с ключом, отказ по коду вендора
 * (402 → исчерпание, 451 → названные проверки, 503/тишина → 529 клиенту Anthropic) и след.
 */

export interface GatewayRequest {
  ctx: HopContext;
  entry: TagEntry;
  request: IncomingMessage;
  response: ServerResponse;
  credential: string;
  path: string;
  /** Диалект клиента (форма отказа). */
  clientKind: DlpApiKind;
  driver: HopDriver;
}

export function traceOf(
  g: GatewayRequest,
  fields: Partial<HopTraceEntry> & { status: number },
): void {
  g.ctx.trace.write({
    at: g.ctx.now(),
    tag: g.entry.spec.tag,
    routeId: g.entry.spec.routeId,
    hop: 'gateway',
    path: g.path,
    ...fields,
  });
}

export function deny(g: GatewayRequest, refusal: Refusal, lost: string[] = []): void {
  refuse(g.response, g.clientKind, refusal, g.ctx.language);
  traceOf(g, {
    status: refusal.status,
    code: refusal.code,
    error: refusal.message,
    ...(lost.length ? { lost } : {}),
  });
}

/** Маска тела в диалекте ВЕРХА: маскируются документированные поля того тела, что уйдёт. */
export function maskOutgoing(
  g: GatewayRequest,
  bodyText: string,
  kind: DlpApiKind,
  vault: AliasVault,
): { body: string; masked: boolean } | { refusal: Refusal } {
  if (!maskingOn(g.entry)) return { body: bodyText, masked: false };
  const set = rulesOf(g.ctx, g.entry.spec);
  if ('broken' in set)
    return {
      refusal: {
        status: 400,
        code: 'dlp_opaque',
        message: hopText('gateway-mask-rules-broken', { error: set.broken }),
      },
    };
  const masked = maskRequestBody(bodyText, kind, set.rules, vault);
  if (!masked)
    return {
      refusal: {
        status: 400,
        code: 'dlp_opaque',
        message: hopText('hop-dlp-opaque', { reason: hopText('gateway-mask-unparsed') }),
      },
    };
  if (masked.blockedBy)
    return {
      refusal: {
        status: 400,
        code: 'dlp_blocked',
        message: hopText('gateway-mask-blocked', { rule: masked.blockedBy.ruleName }),
      },
    };
  return { body: masked.body, masked: masked.hits.length > 0 };
}

/** Клиенту Anthropic «подождите» — 529: его Claude Code повторяет, 503 — сдаётся раньше. */
export function busyStatus(kind: DlpApiKind): number {
  return kind === 'anthropic' ? 529 : 503;
}

export interface SentUpstream {
  reply: UpstreamReply;
  abort: AbortController;
}

/**
 * Поход наверх с ключом маршрута. Отказ (ключ не прочитан, связи нет, тишина) уходит клиенту
 * здесь же; `undefined` — ответа нет, работа запроса кончена.
 */
export async function sendUpstream(
  g: GatewayRequest,
  upstreamPath: string,
  body: string,
  extraHeaders: Record<string, string>,
  lost: string[],
): Promise<SentUpstream | undefined> {
  const auth = upstreamAuth(g.ctx, g.entry, g.credential);
  if ('refusal' in auth) {
    deny(g, { status: 401, code: 'authentication_error', message: auth.refusal }, lost);
    return undefined;
  }
  const abort = new AbortController();
  const gone = clientGone(g.response);
  gone.addEventListener('abort', () => abort.abort(gone.reason), { once: true });
  try {
    const reply = await callUpstream({
      url: upstreamUrl(g.entry, upstreamPath),
      method: 'POST',
      headers: {
        ...extraHeaders,
        ...auth.headers,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body,
      signal: abort.signal,
      headersTimeoutMs: g.ctx.stallMs,
      retryPauseMs: g.ctx.retryPauseMs,
      ...(auth.secret ? { secret: auth.secret } : {}),
      ...(g.ctx.fetchImpl ? { fetchImpl: g.ctx.fetchImpl } : {}),
    });
    return { reply, abort };
  } catch (error) {
    if (error instanceof UpstreamError && error.kind === 'timeout') {
      deny(
        g,
        {
          status: busyStatus(g.clientKind),
          code: 'overloaded_error',
          message: hopText('hop-stalled', { seconds: Math.round(g.ctx.stallMs / 1_000) }),
        },
        lost,
      );
    } else {
      const message = error instanceof UpstreamError ? error.message : String(error);
      deny(g, { status: 502, code: 'api_error', message }, lost);
    }
    return undefined;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Отказ вендора кодом ответа. Тело вендора наружу НЕ идёт (в перечне 451 бывает кусок
 * запроса) — клиент получает свою форму и причину словами; 402 — отметка исчерпания маршрута,
 * которую снимает только человек (G11).
 */
export async function refuseUpstreamStatus(
  g: GatewayRequest,
  upstream: Response,
  model: string,
  lost: string[],
  retried: boolean,
): Promise<void> {
  const body = safeJson(await upstream.text());
  if (upstream.status === 402) g.ctx.spend.markExhausted(g.entry.spec.routeId, g.ctx.now());
  const bridged = bridgeUpstreamStatus(upstream.status, body, {
    model,
    retryAfterSeconds: retryAfterSeconds(upstream),
    driverRows: g.driver.statusRows,
    violationNames: g.driver.violationNames,
  });
  const status = bridged.status === 503 && g.clientKind === 'anthropic' ? 529 : bridged.status;
  refuse(
    g.response,
    g.clientKind,
    { status, code: bridged.code, message: bridged.message },
    g.ctx.language,
  );
  traceOf(g, {
    status,
    code: upstream.status === 402 ? 'billing_error' : bridged.code,
    error: bridged.message,
    ...(bridged.violations.length ? { violations: bridged.violations } : {}),
    ...(lost.length ? { lost } : {}),
    ...(retried ? { retried: true } : {}),
  });
}
