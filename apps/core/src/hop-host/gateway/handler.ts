import type { IncomingMessage, ServerResponse } from 'node:http';
import { refuseIfExhausted, sessionContext, type HopContext } from '../context.ts';
import { driverOf } from '../features.ts';
import { apiKindOf, apiKindOfPath, readBody, refuse } from '../http.ts';
import { credentialOf } from '../tags.ts';
import { bridgeChat } from './bridge.ts';
import { deny, traceOf, type GatewayRequest } from './common.ts';
import { nativeChat } from './native.ts';
import { hopText } from './texts.ts';

/**
 * Вход шлюза: метка по заглушке → исчерпание → тело → ручка. Перевод диалекта (клиент ≠ верх)
 * или возможности на OpenAI-верхе — мост; Anthropic ↔ Anthropic с возможностями — родная ручка.
 * Шлюз отвечает ТОЛЬКО на ручку разговора: прочие пути без перевода сюда не попадают (их
 * сеанс получает DLP-звено), и молча их пропускать значило бы ходить мимо маски.
 */

const CHAT_PATHS = new Set(['/v1/messages', '/v1/chat/completions']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function handleGatewayRequest(
  hostCtx: HopContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
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
  const g: GatewayRequest = {
    ctx,
    entry,
    request,
    response,
    credential,
    path,
    clientKind: apiKindOf(entry.spec.from),
    driver: driverOf(entry.spec),
  };
  if (refuseIfExhausted(ctx, entry, response, g.clientKind)) {
    traceOf(g, { status: 402, code: 'billing_error' });
    return;
  }
  if (request.method !== 'POST' || !CHAT_PATHS.has(path)) {
    request.resume();
    return deny(g, {
      status: 404,
      code: 'not_found_error',
      message: hopText('gateway-route-unknown'),
    });
  }
  const raw = await readBody(request);
  if (raw === undefined) {
    request.destroy();
    return deny(g, {
      status: 413,
      code: 'request_too_large',
      message: hopText('gateway-body-too-large'),
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    body = undefined;
  }
  if (!isRecord(body))
    return deny(g, {
      status: 400,
      code: 'invalid_request_error',
      message: hopText('gateway-body-not-json'),
    });
  const native = entry.spec.from === 'anthropic-messages' && entry.spec.to === 'anthropic-messages';
  await (native ? nativeChat(g, body) : bridgeChat(g, body));
}
