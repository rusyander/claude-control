import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DlpApiKind } from '@agentdeck/dlp/api-shapes';
import { refuseIfExhausted, sessionContext, type HopContext } from '../context.ts';
import { driverOf } from '../features.ts';
import type { TagEntry } from '../host.types.ts';
import { apiKindOf, closeAfterReply, readBody, refuse } from '../http.ts';
import { credentialOf } from '../tags.ts';
import { bridgeChat } from './bridge.ts';
import { deny, traceOf, type GatewayRequest } from './common.ts';
import {
  edgeRouteOf,
  GATEWAY_ROUTES_TEXT,
  googleChat,
  responsesChat,
  type EdgeRoute,
} from './edge.ts';
import { googleResponse } from './google-bridge/google-bridge.ts';
import { imagesRequest } from './images.ts';
import { modelsList } from './models.ts';
import { nativeChat } from './native.ts';
import { hopText } from './texts.ts';

/**
 * Вход шлюза: метка по заглушке → исчерпание → тело → ручка. Перевод диалекта (клиент ≠ верх)
 * или возможности на OpenAI-верхе — мост; Anthropic ↔ Anthropic с возможностями — родная ручка;
 * Responses и Gemini — перевод на краю (`edge.ts`) и тот же мост; `GET /v1/models` — список
 * моделей верха (`models.ts`); `POST /v1/images/generations` — ручка картинок контура (`images.ts`,
 * без повтора). Шлюз отвечает ТОЛЬКО на эти ручки: прочие пути без перевода сюда не попадают (их сеанс получает DLP-звено), и молча
 * их пропускать значило бы ходить мимо маски.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Форма отказа по ручке: Anthropic — у `messages`, остальные — OpenAI (Gemini переведёт обёртка). */
export function kindOfRoute(route: EdgeRoute | undefined, path: string): DlpApiKind {
  if (route) return route === 'messages' ? 'anthropic' : 'openai-compat';
  return path.includes('/messages') ? 'anthropic' : 'openai-compat';
}

/** Список моделей: путь один в обоих диалектах (`/v1/models`). */
function isModelsPath(path: string): boolean {
  return path.replace(/\/+$/, '').endsWith('/v1/models');
}

/** Ручка картинок контура: форма OpenAI, путь один (`/v1/images/generations`). */
function isImagesPath(path: string): boolean {
  return path.replace(/\/+$/, '').endsWith('/v1/images/generations');
}

/**
 * Диалект клиента: у списка моделей маршрут о клиенте не говорит ничего — признак тот, который
 * API Anthropic требует от каждого запроса (`anthropic-version`). Картинки — только форма OpenAI.
 */
function clientKindOf(
  models: boolean,
  request: IncomingMessage,
  route: EdgeRoute | undefined,
  path: string,
  entry: TagEntry,
): DlpApiKind {
  if (models)
    return request.headers['anthropic-version'] === undefined ? 'openai-compat' : 'anthropic';
  if (isImagesPath(path)) return 'openai-compat';
  return route ? kindOfRoute(route, path) : apiKindOf(entry.spec.from);
}

export async function handleGatewayRequest(
  hostCtx: HopContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  const route = edgeRouteOf(path);
  // Клиент Gemini читает отказ только в форме Google API — переводится КАЖДЫЙ ответ ручки.
  const out = route === 'google' ? googleResponse(response) : response;
  const credential = credentialOf(request);
  const entry = hostCtx.tags.lookup(credential);
  if (!entry || !credential) {
    request.resume();
    return refuse(
      out,
      kindOfRoute(route, path),
      { status: 401, code: 'authentication_error', message: hopText('hop-unknown-tag') },
      hostCtx.language,
    );
  }
  await serveGatewayEntry(sessionContext(hostCtx, entry), entry, {
    request,
    response: out,
    raw: response,
    credential,
    path,
    route,
  });
}

export interface GatewayCall {
  request: IncomingMessage;
  /** Ответ клиенту (у Gemini — обёртка перевода). */
  response: ServerResponse;
  /** Настоящий ответ: `:countTokens` Gemini пишет мимо обёртки. */
  raw: ServerResponse;
  credential: string;
  /** Путь без строки запроса и без префикса контура. */
  path: string;
  route: EdgeRoute | undefined;
}

/**
 * Опознанный запрос (метка сеанса или маршрут контура шлюза человека): исчерпание → ручка →
 * тело → перевод. Общий для обоих входов — второй конвейер разошёлся бы с первым молча.
 */
export async function serveGatewayEntry(
  ctx: HopContext,
  entry: TagEntry,
  call: GatewayCall,
): Promise<void> {
  const { request, route } = call;
  const models = request.method === 'GET' && isModelsPath(call.path);
  const g: GatewayRequest = {
    ctx,
    entry,
    request,
    response: call.response,
    credential: call.credential,
    path: call.path,
    clientKind: clientKindOf(models, request, route, call.path, entry),
    driver: driverOf(entry.spec),
  };
  if (refuseIfExhausted(ctx, entry, call.response, g.clientKind)) {
    request.resume();
    traceOf(g, { status: 402, code: 'billing_error' });
    return;
  }
  if (models) {
    request.resume();
    return modelsList(g);
  }
  if (request.method === 'POST' && isImagesPath(call.path)) return imagesRequest(g);
  if (request.method !== 'POST' || !route) {
    request.resume();
    return deny(g, {
      status: 404,
      code: 'not_found_error',
      message: hopText('gateway-route-unknown', { routes: GATEWAY_ROUTES_TEXT }),
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
  // Лента хода локального маршрута: запрос в полёте до закрытия ответа (этап 11, W2-5).
  const activityDone = ctx.activity?.begin(entry, {
    credential: call.credential,
    route,
    path: call.path,
    body,
  });
  if (activityDone) call.raw.once('close', activityDone);
  if (route === 'responses') return responsesChat(g, body);
  if (route === 'google') return googleChat(g, call.raw, body);
  const native =
    route === 'messages' &&
    entry.spec.from === 'anthropic-messages' &&
    entry.spec.to === 'anthropic-messages';
  await (native ? nativeChat(g, body) : bridgeChat(g, body));
}
