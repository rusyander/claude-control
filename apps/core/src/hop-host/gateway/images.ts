import { AliasVault, maskText } from '@agentdeck/dlp/mask';
import { maskingOn, rulesOf, upstreamAuth, upstreamUrl } from '../context.ts';
import { clientGone, closeAfterReply, readBody } from '../http.ts';
import { callUpstream, UpstreamError } from '../upstream.ts';
import {
  countContour,
  deny,
  refuseUpstreamStatus,
  traceOf,
  type GatewayRequest,
} from './common.ts';
import { hopText } from './texts.ts';

/**
 * Ручка картинок контура (`POST /v1/images/generations`, манифест `imagesApi`) — перенос
 * `images.ts` шлюза панели. Чем она отличается от разговора:
 *   - ПОВТОРА НЕТ: картинка — платная работа, которая могла состояться; повтор нарисовал бы и
 *     списал её дважды;
 *   - заголовков ждём дольше (180 с): ручка не потоковая, заголовки приходят с готовой картинкой;
 *   - ответ уходит клиенту БАЙТ В БАЙТ, в след — только размер картинки, ни байта её самой;
 *   - маска смотрит на ПРОМПТ: у ручки нет `messages`, разбор тела по диалекту чата пропустил бы
 *     промпт немаскированным.
 */

/** Потолок ожидания заголовков: столько же ждала картинку панель. */
export const IMAGES_HEADERS_TIMEOUT_MS = 180_000;

/** Потолок ответа: base64 длиннее байтов на треть, картинка панели — до 8 МБ. */
const MAX_IMAGES_ANSWER_BYTES = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Расход, если ручка его прислала: у OpenAI — `input/output_tokens`. */
function usageOf(payload: Record<string, unknown> | undefined): { input: number; output: number } {
  const usage = payload && isRecord(payload.usage) ? payload.usage : {};
  return {
    input: numberOf(usage.input_tokens) || numberOf(usage.prompt_tokens),
    output: numberOf(usage.output_tokens) || numberOf(usage.completion_tokens),
  };
}

/** Размер картинок по base64 строк `data` — только число. */
function imageBytesOf(payload: Record<string, unknown> | undefined): number {
  const rows = payload && Array.isArray(payload.data) ? payload.data : [];
  let bytes = 0;
  for (const row of rows) {
    if (isRecord(row) && typeof row.b64_json === 'string')
      bytes += Math.floor((row.b64_json.replace(/=+$/, '').length * 3) / 4);
  }
  return bytes;
}

async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_IMAGES_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/** Промпт через маску — тем же решением, что разговор, и тем же fail-closed. */
function maskPrompt(
  g: GatewayRequest,
  body: Record<string, unknown>,
): { body: Record<string, unknown> } | { refusal: string } {
  if (!maskingOn(g.entry) || typeof body.prompt !== 'string') return { body };
  const set = rulesOf(g.ctx, g.entry.spec);
  if ('broken' in set)
    return { refusal: hopText('gateway-mask-rules-broken', { error: set.broken }) };
  const vault = new AliasVault(
    g.driver.placeholderPattern ? { avoid: g.driver.placeholderPattern } : {},
  );
  const result = maskText(body.prompt, set.rules, vault);
  if (result.blockedBy)
    return { refusal: hopText('gateway-mask-blocked', { rule: result.blockedBy.ruleName }) };
  return { body: { ...body, prompt: result.text } };
}

export async function imagesRequest(g: GatewayRequest): Promise<void> {
  const { ctx, entry, request } = g;
  const images = g.driver.images;
  if (!images) {
    request.resume();
    return deny(g, {
      status: 404,
      code: 'not_found_error',
      message: hopText('gateway-images-not-declared', { title: entry.title ?? entry.spec.routeId }),
    });
  }
  const raw = await readBody(request);
  if (raw === undefined) {
    closeAfterReply(request, g.response);
    return deny(g, {
      status: 413,
      code: 'request_too_large',
      message: hopText('gateway-body-too-large'),
    });
  }
  const body = parseObject(raw.toString('utf8'));
  if (!body)
    return deny(g, {
      status: 400,
      code: 'invalid_request_error',
      message: hopText('gateway-body-not-json'),
    });
  const masked = maskPrompt(g, body);
  // 400, а не 403: отказ по содержимому — не ошибка доступа.
  if ('refusal' in masked)
    return deny(g, { status: 400, code: 'invalid_request_error', message: masked.refusal });

  const model = typeof body.model === 'string' ? body.model : '';
  const auth = upstreamAuth(ctx, entry, g.credential);
  if ('refusal' in auth)
    return deny(g, { status: 401, code: 'authentication_error', message: auth.refusal });
  let upstream: Response;
  try {
    const reply = await callUpstream({
      url: upstreamUrl(entry, `/v1/${images.api}`),
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(masked.body),
      signal: clientGone(g.response),
      headersTimeoutMs: IMAGES_HEADERS_TIMEOUT_MS,
      // Платная картинка повтором рисуется и списывается дважды.
      retry: false,
      ...(auth.secret ? { secret: auth.secret } : {}),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    });
    upstream = reply.response;
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message : String(error);
    return deny(g, { status: 502, code: 'api_error', message });
  }
  if (upstream.status >= 400) return refuseUpstreamStatus(g, upstream, model, [], false);
  const text = await readCapped(upstream);
  if (text === undefined)
    return deny(g, {
      status: 502,
      code: 'api_error',
      message: hopText('gateway-images-too-large'),
    });
  g.response.writeHead(200, { 'content-type': 'application/json' });
  g.response.end(text);
  const payload = parseObject(text);
  const usage = usageOf(payload);
  const tokens = usage.input + usage.output;
  // Ответ уже ушёл человеку — расход был; ноль значит «ручка не отчиталась», и след так и
  // говорит (`usageUnreported`), а не молчаливым нулём.
  if (tokens > 0)
    ctx.spend.add(
      entry.spec,
      model,
      { input: usage.input, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: usage.output },
      ctx.now(),
    );
  const imageBytes = imageBytesOf(payload);
  countContour(g, {
    model,
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: tokens,
    ...(tokens === 0 ? { unreported: true as const } : {}),
  });
  traceOf(g, {
    status: 200,
    tokens,
    ...(tokens === 0 ? { usageUnreported: true as const } : {}),
    ...(imageBytes > 0 ? { imageBytes } : {}),
  });
}
