import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiKindForPath, type DlpApiKind } from '@agentdeck/dlp/api-shapes';
import { AliasVault } from '@agentdeck/dlp/mask';
import { maskRequestBody } from '@agentdeck/dlp/request-filter';
import { ResponseStreamFilter, restoreJsonResponse } from '@agentdeck/dlp/response-filter';
import {
  maskingOn,
  refuseIfExhausted,
  rulesOf,
  sessionContext,
  upstreamAuth,
  upstreamUrl,
  type HopContext,
} from '../context.ts';
import { hopText } from '../gateway/texts.ts';
import type { HopTraceEntry, TagEntry } from '../host.types.ts';
import type { SpendUsage } from '../spend.types.ts';
import {
  apiKindOf,
  apiKindOfPath,
  clientGone,
  readBody,
  refuse,
  write,
  type Refusal,
} from '../http.ts';
import { credentialOf } from '../tags.ts';
import { callUpstream, pumpWithStall, UpstreamError } from '../upstream.ts';
import { jsonUsage, streamMeter } from './meter.ts';

/**
 * DLP-звено (перенос `DlpProxy` панели, P124): сеанс того же диалекта, что и верх, идёт сюда —
 * тело маскируется правилами, ключ подставляется по ссылке маршрута, расход считается по метке.
 *
 * Жёстко, без настроек:
 * 1. Слушатель только на 127.0.0.1 (хост) — звено видит расшифрованные запросы.
 * 2. TLS не вскрывается: CLI ходит сюда по http, наверх звено идёт само.
 * 3. FAIL-CLOSED: при включённой маске тело, которое звено не разобрало, НЕ уходит — отказ
 *    `dlp_opaque`. Пропуск непонятого при маске — уверенность, которой звено не заслужило.
 *    Звено лежит — CLI упирается в закрытый порт: адреса «мимо звена» у сеанса нет.
 */

/** Заголовки соединения и доступа не пересылаются: они про ЭТОТ канал, ключ подставляет звено. */
const DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'x-api-key',
  'authorization',
]);

function forwardHeaders(
  request: IncomingMessage,
  body: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROP.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  // Сжатый ответ нельзя ни прочитать, ни развернуть в нём метку — просим несжатый.
  headers['accept-encoding'] = 'identity';
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  return headers;
}

function responseHeaders(upstream: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding')
      return;
    headers[name] = value;
  });
  return headers;
}

interface Prepared {
  body: string | undefined;
  kind: DlpApiKind | undefined;
  masked: boolean;
  vault: AliasVault;
}

/** Решение маски по телу: готовое тело наверх или отказ. Отдельно — чтобы тест видел решение. */
export function prepareBody(
  ctx: HopContext,
  entry: TagEntry,
  path: string,
  raw: Buffer,
): Prepared | { refusal: Refusal } {
  const vault = new AliasVault();
  const kind = apiKindForPath(path);
  // Тела нет (список моделей) — данных нет, идёт как есть.
  if (!raw.length) return { body: undefined, kind, masked: false, vault };
  if (!maskingOn(entry)) return { body: raw.toString('utf8'), kind, masked: false, vault };
  const set = rulesOf(ctx, entry.spec);
  if ('broken' in set)
    return {
      refusal: {
        status: 400,
        code: 'dlp_opaque',
        message: hopText('gateway-mask-rules-broken', { error: set.broken }),
      },
    };
  const masked = kind ? maskRequestBody(raw.toString('utf8'), kind, set.rules, vault) : undefined;
  if (!masked) {
    const reason = kind ? hopText('proxy-body-not-json') : hopText('proxy-shape-unknown');
    return {
      refusal: { status: 400, code: 'dlp_opaque', message: hopText('hop-dlp-opaque', { reason }) },
    };
  }
  if (masked.blockedBy) {
    // 400, а не 403: Claude Code читает 403 как ошибку входа, и человек чинил бы ключ.
    return {
      refusal: {
        status: 400,
        code: 'dlp_blocked',
        message: hopText('gateway-mask-blocked', { rule: masked.blockedBy.ruleName }),
      },
    };
  }
  return { body: masked.body, kind, masked: masked.hits.length > 0, vault };
}

export async function handleDlpRequest(
  hostCtx: HopContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url ?? '/';
  const credential = credentialOf(request);
  const entry = hostCtx.tags.lookup(credential);
  if (!entry || !credential) {
    return refuse(
      response,
      apiKindOfPath(path),
      { status: 401, code: 'authentication_error', message: hopText('hop-unknown-tag') },
      hostCtx.language,
    );
  }
  const ctx = sessionContext(hostCtx, entry);
  const clientKind = apiKindOf(entry.spec.from);
  const trace = (fields: Partial<HopTraceEntry> & { status: number }): void =>
    ctx.trace.write({
      at: ctx.now(),
      tag: entry.spec.tag,
      routeId: entry.spec.routeId,
      hop: 'dlp',
      path,
      ...fields,
    });
  const deny = (refusal: Refusal): void => {
    refuse(response, clientKind, refusal, ctx.language);
    trace({ status: refusal.status, code: refusal.code, error: refusal.message });
  };

  if (refuseIfExhausted(ctx, entry, response, clientKind)) {
    trace({ status: 402, code: 'billing_error' });
    return;
  }
  const raw = await readBody(request);
  if (raw === undefined) {
    deny({ status: 413, code: 'request_too_large', message: hopText('proxy-body-too-large') });
    request.destroy();
    return;
  }
  const prepared = prepareBody(ctx, entry, path, raw);
  if ('refusal' in prepared) return deny(prepared.refusal);
  const auth = upstreamAuth(ctx, entry, credential);
  if ('refusal' in auth)
    return deny({ status: 401, code: 'authentication_error', message: auth.refusal });

  const upstreamAbort = new AbortController();
  const gone = clientGone(response);
  gone.addEventListener('abort', () => upstreamAbort.abort(gone.reason), { once: true });
  let reply;
  try {
    reply = await callUpstream({
      url: upstreamUrl(entry, path),
      method: request.method ?? 'GET',
      headers: { ...forwardHeaders(request, prepared.body), ...auth.headers },
      ...(prepared.body !== undefined ? { body: prepared.body } : {}),
      signal: upstreamAbort.signal,
      headersTimeoutMs: ctx.stallMs,
      retryPauseMs: ctx.retryPauseMs,
      ...(auth.secret ? { secret: auth.secret } : {}),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : String(error);
    const stalled = error instanceof UpstreamError && error.kind === 'timeout';
    return deny(
      stalled
        ? {
            status: clientKind === 'anthropic' ? 529 : 503,
            code: 'overloaded_error',
            message: hopText('hop-stalled', { seconds: Math.round(ctx.stallMs / 1_000) }),
          }
        : { status: 502, code: 'api_error', message },
    );
  }
  const upstream = reply.response;
  if (upstream.status === 402) ctx.spend.markExhausted(entry.spec.routeId, ctx.now());

  const contentType = upstream.headers.get('content-type') ?? '';
  const kind = prepared.kind;
  const headers = responseHeaders(upstream);
  const model = modelOf(prepared.body);
  let usage: SpendUsage = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
  let error: string | undefined;

  if (kind && contentType.includes('text/event-stream')) {
    const filter = new ResponseStreamFilter(kind, prepared.vault.reverse());
    const meter = streamMeter(kind);
    response.writeHead(upstream.status, headers);
    response.flushHeaders();
    try {
      const end = await pumpWithStall(
        upstream.body,
        ctx.stallMs,
        () => upstreamAbort.abort(new Error('stalled')),
        async (text) => {
          meter.push(text);
          await write(response, filter.push(text));
        },
        () => response.destroyed,
      );
      if (end === 'stalled')
        error = hopText('hop-stalled', { seconds: Math.round(ctx.stallMs / 1_000) });
    } catch (cause) {
      error = hopText('gateway-answer-broken', {
        reason: (cause as Error).message ?? String(cause),
      });
    }
    meter.end();
    usage = meter.usage();
    if (!response.destroyed) response.end(filter.end());
  } else if (kind && contentType.includes('application/json')) {
    const text = await upstream.text();
    let out = text;
    try {
      const payload = JSON.parse(text) as unknown;
      usage = jsonUsage(kind, payload);
      out = JSON.stringify(restoreJsonResponse(payload, kind, prepared.vault.reverse()));
    } catch {
      // Не JSON вопреки заголовку — отдаём как пришло, ничего не выдумывая.
    }
    response.writeHead(upstream.status, headers);
    response.end(out);
  } else {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, headers);
    response.end(buffer);
  }

  const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  if (tokens > 0) ctx.spend.add(entry.spec, model, usage, ctx.now());
  trace({
    status: upstream.status,
    ...(upstream.status === 402 ? { code: 'billing_error' } : {}),
    masked: prepared.masked,
    tokens,
    ...(reply.retried ? { retried: true } : {}),
    ...(error ? { error } : {}),
  });
}

function modelOf(body: string | undefined): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : '';
  } catch {
    return '';
  }
}
