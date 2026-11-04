import type { ServerResponse } from 'node:http';
import { bridgeChat } from './bridge.ts';
import { deny, type GatewayRequest } from './common.ts';
import {
  estimateGoogleTokens,
  googleRequestToChat,
  parseGooglePath,
} from './google-bridge/google-bridge.ts';
import { bridgedResponse, responsesRequestToChat } from './responses-bridge/responses-bridge.ts';
import { hopText } from './texts.ts';

/**
 * Перевод на краю шлюза звена (этап 10, план Q7): тела Responses (Codex) и Gemini API
 * переводятся в OpenAI chat ДО всего остального и идут общим мостом — маска, ключ, прослойка,
 * расход и след те же, что у клиента OpenAI. DLP поэтому судит уже переведённое тело верха
 * (`openai-compat`, которое пакет DLP разбирает). Чего перевести нельзя
 * (`previous_response_id`, тело без запроса) — отказ 400 до похода наверх, при любой маске:
 * непереведённое тело не уходит мимо неё никогда.
 */

/** Ручка разговора по пути; остальное шлюз звена не принимает. */
export type EdgeRoute = 'messages' | 'chat' | 'responses' | 'google';

/** Список ручек для отказа «не та ручка» — человек видит, что шлюз принимает. */
export const GATEWAY_ROUTES_TEXT =
  '/v1/messages, /v1/chat/completions, /v1/responses, /v1/models, /v1/images/generations, /v1beta/models/<model>:generateContent';

export function edgeRouteOf(path: string): EdgeRoute | undefined {
  const clean = path.replace(/\/+$/, '');
  // Первым: имя модели Gemini в пути произвольно и могло бы кончаться чем угодно.
  if (parseGooglePath(clean)) return 'google';
  if (clean.endsWith('/v1/messages')) return 'messages';
  if (clean.endsWith('/v1/chat/completions')) return 'chat';
  if (clean.endsWith('/v1/responses')) return 'responses';
  return undefined;
}

/** `/v1/responses`: перевод в chat, ответ моста — обратно событиями Responses. */
export async function responsesChat(
  g: GatewayRequest,
  body: Record<string, unknown>,
): Promise<void> {
  const bridged = responsesRequestToChat(body);
  if (!bridged || 'refusal' in bridged)
    return deny(g, {
      status: 400,
      code: 'invalid_request_error',
      message: bridged ? bridged.refusal : hopText('gateway-responses-not-request'),
    });
  const out = bridgedResponse(g.response, bridged);
  await bridgeChat(
    { ...g, response: out, clientKind: 'openai-compat' },
    bridged.chat,
    bridged.dropped,
  );
}

/**
 * Ручки Gemini: `:countTokens` — оценка на месте (контура не касается, без следа и расхода);
 * остальные — перевод в chat. `g.response` уже обёрнут `googleResponse` вызывающим: так в
 * форме Google уходит и каждый ранний отказ.
 */
export async function googleChat(
  g: GatewayRequest,
  raw: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const target = parseGooglePath(g.path);
  if (!target)
    return deny(g, {
      status: 404,
      code: 'not_found_error',
      message: hopText('gateway-route-unknown', { routes: GATEWAY_ROUTES_TEXT }),
    });
  if (target.method === 'countTokens') {
    raw.writeHead(200, { 'content-type': 'application/json' });
    raw.end(JSON.stringify({ totalTokens: estimateGoogleTokens(body) }));
    return;
  }
  const bridged = googleRequestToChat(
    body,
    target.model,
    target.method === 'streamGenerateContent',
  );
  if (!bridged || 'refusal' in bridged)
    return deny(g, {
      status: 400,
      code: 'invalid_request_error',
      message: bridged ? bridged.refusal : hopText('gateway-google-not-request'),
    });
  await bridgeChat({ ...g, clientKind: 'openai-compat' }, bridged.chat, bridged.dropped);
}
