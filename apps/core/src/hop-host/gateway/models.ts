import { respondJson } from '../http.ts';
import { refuseUpstreamStatus, sendUpstream, traceOf, type GatewayRequest } from './common.ts';
import { openAiModelsToAnthropic } from './dialect/dialect.ts';

/**
 * Список моделей (`GET /v1/models`) шлюза человека — перенос `models` шлюза в панели. Путь в обоих
 * диалектах один, поэтому клиент узнаётся по `anthropic-version` (его шлёт каждый клиент
 * Anthropic). Контур отдаёт список по-OpenAI: клиенту OpenAI он уходит байт в байт (пересборка
 * потеряла бы поля, которых мост не знает), клиенту Anthropic — в его схеме. Ключ, отказы
 * вендора, исчерпание 402 и след — те же, что у разговора.
 */

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function modelsList(g: GatewayRequest): Promise<void> {
  const sent = await sendUpstream(g, '/v1/models', null, {}, []);
  if (!sent) return;
  const upstream = sent.reply.response;
  if (upstream.status >= 400) return refuseUpstreamStatus(g, upstream, '', [], sent.reply.retried);
  const text = await upstream.text();
  if (g.clientKind === 'anthropic')
    respondJson(g.response, 200, openAiModelsToAnthropic(safeJson(text)));
  else {
    g.response.writeHead(200, { 'content-type': 'application/json' });
    g.response.end(text);
  }
  traceOf(g, { status: 200, ...(sent.reply.retried ? { retried: true } : {}) });
}
