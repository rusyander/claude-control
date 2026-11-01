import type { ServerResponse } from 'node:http';
import { AliasVault } from '@agentdeck/dlp/mask';
import { ResponseStreamFilter, restoreJsonResponse } from '@agentdeck/dlp/response-filter';
import { hasFeature } from '../features.ts';
import { respondJson, write } from '../http.ts';
import { pumpWithStall } from '../upstream.ts';
import {
  AnthropicStreamMeter,
  messageFacts,
  nativeErrorFrame,
  nativeHeaders,
  type NativeFacts,
} from './anthropic-native.ts';
import {
  busyStatus,
  deny,
  maskOutgoing,
  refuseUpstreamStatus,
  sendUpstream,
  traceOf,
  type GatewayRequest,
} from './common.ts';
import { errorBody, statusOfErrorCode } from './dialect/dialect.ts';
import { expandDeferredTools } from './local-window/deferred-tools.ts';
import { NativeThinkFilter, withoutThinkMessage } from './native-think/native-think.ts';
import { hopText } from './texts.ts';

/**
 * Родная ручка шлюза (перенос `nativeChat` конвейера панели): клиент и верх — Anthropic
 * Messages, а звено нужно ради возможностей маршрута (отложенные инструменты, хвост
 * размышлений). Байты идут клиенту как пришли, факты читаются сбоку; ключ, маска, отказы
 * вендора и расход — те же, что у моста.
 */

/** Потолок цельного ответа (клиент просил не поток). */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function nativeChat(
  g: GatewayRequest,
  clientBody: Record<string, unknown>,
): Promise<void> {
  const { ctx, entry, driver } = g;
  const prepared = hasFeature(entry.spec, 'deferred-tools')
    ? expandDeferredTools(clientBody, true)
    : clientBody;
  const model = typeof prepared.model === 'string' ? prepared.model : '';
  const vault = new AliasVault(
    driver.placeholderPattern ? { avoid: driver.placeholderPattern } : {},
  );
  const guarded = maskOutgoing(g, JSON.stringify(prepared), 'anthropic', vault);
  if ('refusal' in guarded) return deny(g, guarded.refusal);

  const sent = await sendUpstream(
    g,
    driver.anthropic?.messages ?? '/v1/messages',
    guarded.body,
    nativeHeaders(g.request),
    [],
  );
  if (!sent) return;
  const upstream = sent.reply.response;
  if (upstream.status >= 400)
    return refuseUpstreamStatus(g, upstream, model, [], sent.reply.retried);

  const restore = new ResponseStreamFilter('anthropic', vault.reverse());
  const meter = new AnthropicStreamMeter();
  // L9 и на родной ручке: модель, пойманная на голом `</think>`, держится до тега.
  const thinkMode = ctx.thinkTail.has(entry.spec.routeId, model) ? 'tail' : 'lead';
  const think = new NativeThinkFilter(thinkMode);
  let thought = { reasoningChars: 0, sawBareClose: false };
  let whole: NativeFacts | undefined;
  let failure: string | undefined;
  const response = g.response;

  if ((upstream.headers.get('content-type') ?? '').includes('event-stream')) {
    thought = think;
    failure = await streamNative(g, upstream.body, () => sent.abort.abort(), meter, restore, think);
  } else {
    let collected = '';
    let overflow = false;
    const end = await pumpWithStall(
      upstream.body,
      ctx.stallMs,
      () => sent.abort.abort(),
      (text) => {
        collected += text;
        if (Buffer.byteLength(collected, 'utf8') > MAX_ANSWER_BYTES) overflow = true;
      },
      () => response.destroyed || overflow,
    ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    if (overflow)
      return deny(g, {
        status: 413,
        code: 'request_too_large',
        message: hopText('gateway-answer-too-large'),
      });
    if (end === 'stalled' || (end !== 'done' && end !== 'gone')) {
      failure =
        end === 'stalled'
          ? hopText('hop-stalled', { seconds: Math.round(ctx.stallMs / 1_000) })
          : hopText('gateway-answer-broken', { reason: end });
      if (!response.destroyed)
        respondJson(
          response,
          busyStatus('anthropic'),
          errorBody('anthropic', `AgentDeck: ${failure}`, 'overloaded_error', ctx.language),
        );
    } else {
      const payload = safeJson(collected);
      whole = messageFacts(payload);
      if (!whole.complete)
        return deny(g, {
          status: 502,
          code: 'api_error',
          message: hopText('gateway-answer-not-model'),
        });
      const split = withoutThinkMessage(payload, thinkMode);
      thought = split;
      respondJson(response, 200, restoreJsonResponse(split.payload, 'anthropic', vault.reverse()));
    }
  }

  const facts = whole ?? meter.facts;
  if (thought.sawBareClose) ctx.thinkTail.mark(entry.spec.routeId, model);
  if (facts.totalTokens > 0) {
    const cacheWrite = facts.cacheWriteTokens;
    ctx.spend.add(
      entry.spec,
      model,
      {
        input: Math.max(facts.promptTokens - facts.cachedTokens - cacheWrite, 0),
        cacheRead: facts.cachedTokens,
        cacheWrite,
        cacheWrite1h: facts.cacheWrite1hTokens,
        output: facts.completionTokens,
      },
      ctx.now(),
    );
  }
  const status = failure
    ? response.destroyed
      ? 499
      : busyStatus('anthropic')
    : facts.upstreamError
      ? statusOfErrorCode(facts.upstreamError.code)
      : facts.complete
        ? 200
        : 502;
  traceOf(g, {
    status,
    masked: guarded.masked,
    tokens: facts.totalTokens,
    ...(sent.reply.retried ? { retried: true } : {}),
    ...(failure
      ? { error: failure }
      : facts.upstreamError
        ? { error: facts.upstreamError.message }
        : facts.complete
          ? {}
          : { error: hopText('gateway-answer-truncated') }),
  });
}

/**
 * Поток родной ручки. Недосказанный поток без ошибки платформы кончается НАШИМ кадром ошибки:
 * молча закрытый клиент покажет удачный короткий ответ. Возвращает причину беды или `undefined`.
 */
async function streamNative(
  g: GatewayRequest,
  body: ReadableStream<Uint8Array> | null,
  abort: () => void,
  meter: AnthropicStreamMeter,
  restore: ResponseStreamFilter,
  think: NativeThinkFilter,
): Promise<string | undefined> {
  const response: ServerResponse = g.response;
  const language = g.ctx.language;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  response.flushHeaders();
  let failure: string | undefined;
  try {
    const end = await pumpWithStall(
      body,
      g.ctx.stallMs,
      abort,
      async (text) => {
        meter.push(text);
        await write(response, restore.push(think.push(text)));
      },
      () => response.destroyed,
    );
    if (end === 'stalled')
      failure = hopText('hop-stalled', { seconds: Math.round(g.ctx.stallMs / 1_000) });
    if (end === 'gone') failure = hopText('gateway-client-gone');
  } catch (error) {
    failure = hopText('gateway-answer-broken', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  meter.end();
  if (response.destroyed || response.writableEnded) return failure;
  const { complete, upstreamError } = meter.facts;
  const tail = failure
    ? nativeErrorFrame(`AgentDeck: ${failure}`, 'overloaded_error', language)
    : complete || upstreamError
      ? ''
      : nativeErrorFrame(
          `AgentDeck: ${hopText('gateway-answer-truncated')}`,
          'api_error',
          language,
        );
  response.end(restore.push(think.end()) + restore.end() + tail);
  return failure;
}
