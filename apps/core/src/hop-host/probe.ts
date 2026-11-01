import type { HopControlReply, HopProbeMessage } from '@agentdeck/contracts/core/hops';
import type { KeyRef } from '@agentdeck/contracts/core/routes';
import { redactSecrets } from '@agentdeck/dlp/redact';
import type { HopContext } from './context.ts';
import type { KeyRead } from './host.types.ts';
import { callUpstream, UpstreamError } from './upstream.ts';

/**
 * Чтение с ключом по просьбе ядра (`probe`, зона R `keyedProbe`): каталог моделей маршрута,
 * закрытый ключом. Ключ читается по ссылке здесь, на этом запросе, кладётся туда, куда велел
 * вызывающий, и обратно не уходит: ни в ответ (отражённый вендором — вычищается), ни в след.
 * Повтора нет — это чтение, `429`/`5xx` вызывающий сам назовёт «не готов».
 */

/** Потолок тела: каталог больших шлюзов — сотни КБ; больше — не каталог, а отказ с причиной. */
export const PROBE_BODY_CAP = 4 * 1024 * 1024;

type Failure = Extract<HopControlReply, { ok: false }>;

function fail(code: string, detail: string): Failure {
  return { op: 'probe', ok: false, code, detail };
}

/**
 * Ключ пробы. `hop-injected` — ключ сеанса под этой меткой (так маршрут шлюза называет свой
 * ключ); у такого сеанса своя ссылка, и цепочка звеньев дальше не разворачивается.
 */
function keyFor(ctx: HopContext, ref: KeyRef): KeyRead | { none: true } {
  if (ref.kind !== 'hop-injected') return ctx.keys.resolve(ref);
  const entry = ctx.tags.byTag(ref.tag);
  if (!entry) return { unknown: `no session registered under tag ${ref.tag}` };
  const own = entry.spec.keyRef;
  if (own === null) return { none: true };
  if (own.kind === 'hop-injected') return { unknown: `tag ${ref.tag} is a hop chain` };
  return ctx.keys.resolve(own);
}

/**
 * Каталог чистится только от значения ключа: общие образцы `redactSecrets` (`api-…`, `token-…`)
 * вырезали бы и id моделей. Отказ (`>= 400`) — текст вендора, его чистка полная, как у шлюза.
 */
function withoutKey(text: string, secret: string | undefined): string {
  return secret && secret.length >= 8 ? text.split(secret).join('«ключ»') : text;
}

async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PROBE_BODY_CAP) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function answerProbe(
  ctx: HopContext,
  message: HopProbeMessage,
): Promise<HopControlReply> {
  if (ctx.spend.exhaustedAt(message.routeId) !== undefined)
    return fail(
      'route_exhausted',
      `route ${message.routeId} is held after 402 until clear-exhausted`,
    );
  const key = keyFor(ctx, message.keyRef);
  if ('absent' in key) return fail('key_unresolved', 'key is absent');
  if ('unknown' in key) return fail('key_unresolved', key.unknown);
  const secret = 'value' in key ? key.value : undefined;

  const headers: Record<string, string> = {};
  const auth = message.auth;
  for (const [name, value] of Object.entries(message.headers)) {
    // Заголовок ключа ставит только звено: чужое значение под тем же именем не едет рядом.
    if ('header' in auth && name.toLowerCase() === auth.header.toLowerCase()) continue;
    headers[name] = value;
  }
  const url = new URL(message.url);
  if (secret !== undefined) {
    if ('header' in auth) headers[auth.header] = auth.scheme ? `${auth.scheme} ${secret}` : secret;
    else url.searchParams.set(auth.query, secret);
  }

  const at = ctx.now();
  const trace = (status: number, code?: string): void =>
    ctx.trace.write({
      at,
      tag: message.keyRef.kind === 'hop-injected' ? message.keyRef.tag : '',
      routeId: message.routeId,
      hop: 'control',
      path: 'probe',
      status,
      ...(code ? { code } : {}),
    });
  let response: Response;
  try {
    ({ response } = await callUpstream({
      url: url.toString(),
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(ctx.stallMs),
      headersTimeoutMs: ctx.stallMs,
      ...(secret !== undefined ? { secret } : {}),
      retry: false,
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
    }));
  } catch (error) {
    const detail =
      error instanceof UpstreamError ? error.message : redactSecrets(String(error), secret);
    trace(502, 'upstream_unreachable');
    return fail('upstream_unreachable', redactSecrets(detail, secret));
  }
  const body = await readCapped(response);
  if (body === undefined) {
    trace(response.status, 'probe_body_too_large');
    return fail('probe_body_too_large', `body over ${PROBE_BODY_CAP} bytes`);
  }
  trace(response.status);
  const contentType = response.headers.get('content-type');
  return {
    op: 'probe',
    ok: true,
    reply: {
      status: response.status,
      body: response.status < 400 ? withoutKey(body, secret) : redactSecrets(body, secret),
      ...(contentType ? { contentType } : {}),
    },
  };
}
