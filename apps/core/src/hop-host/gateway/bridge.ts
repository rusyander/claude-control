import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { AliasVault } from '@agentdeck/dlp/mask';
import { ResponseStreamFilter, restoreJsonResponse } from '@agentdeck/dlp/response-filter';
import { hasFeature } from '../features.ts';
import { respondJson, write } from '../http.ts';
import { pumpWithStall } from '../upstream.ts';
import {
  busyStatus,
  deny,
  maskOutgoing,
  refuseUpstreamStatus,
  sendUpstream,
  traceOf,
  type GatewayRequest,
} from './common.ts';
import { openAiUsage } from './dialect/cache-usage.ts';
import {
  anthropicRequestToOpenAi,
  chooseToolRoute,
  errorBody,
  forwardsCacheMarks,
  openAiRequestWithShim,
  openAiResponseToAnthropic,
  statusOfErrorCode,
} from './dialect/dialect.ts';
import { StreamTranslator } from './frames/frames.ts';
import { expandDeferredTools } from './local-window/deferred-tools.ts';
import { noteSummarized } from './summarized-ledger/summarized-ledger.ts';
import { hopText } from './texts.ts';
import { historyHasToolUse } from './tool-shim/encode.ts';
import { TOOL_PROTOCOL_TEXT } from './tool-shim/protocol-text.ts';

/**
 * Мост шлюза (перенос `chat()` конвейера панели, урезанный до того, что маршрут ядра
 * использует сейчас, G2): клиент Anthropic или OpenAI → верх OpenAI chat. Перевод диалекта,
 * прослойка инструментов, маска, поход с ключом, отказы вендора, перевод потока обратно,
 * расход по метке. Ответ наверх ВСЕГДА потоком: первые токены видны до конца ответа, а
 * цельному клиенту ответ собирается здесь.
 */

/** Потолок собранного ответа для клиента, просившего не поток. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function bridgeChat(
  g: GatewayRequest,
  clientBody: Record<string, unknown>,
): Promise<void> {
  const { ctx, entry, driver } = g;
  const anthropic = g.clientKind === 'anthropic';
  const route = chooseToolRoute(
    { toolShim: hasFeature(entry.spec, 'tool-shim'), platformTools: false },
    driver,
    () => TOOL_PROTOCOL_TEXT,
  );
  const prepared = hasFeature(entry.spec, 'deferred-tools')
    ? expandDeferredTools(clientBody, true)
    : clientBody;
  const translated = anthropic
    ? anthropicRequestToOpenAi(
        prepared,
        driver.requestFields,
        route,
        forwardsCacheMarks(driver, prepared.model),
      )
    : openAiRequestWithShim(prepared, driver.requestFields, route);
  const lost = translated.lost.map((item) => item.field);
  const allowed = new Set(translated.tools.map((tool) => tool.name));
  const model = typeof translated.body.model === 'string' ? translated.body.model : '';
  // Наверх — поток всегда, с расходом в последнем кадре (`nonstream-120s` панели).
  const upstreamBody = {
    ...translated.body,
    stream: true,
    stream_options: {
      ...(isRecord(translated.body.stream_options) ? translated.body.stream_options : {}),
      include_usage: true,
    },
  };
  const vault = new AliasVault(
    driver.placeholderPattern ? { avoid: driver.placeholderPattern } : {},
  );
  const guarded = maskOutgoing(g, JSON.stringify(upstreamBody), 'openai-compat', vault);
  if ('refusal' in guarded) return deny(g, guarded.refusal, lost);

  const sent = await sendUpstream(g, '/v1/chat/completions', guarded.body, {}, lost);
  if (!sent) return;
  const upstream = sent.reply.response;
  if (upstream.status >= 400)
    return refuseUpstreamStatus(g, upstream, model, lost, sent.reply.retried);

  const translator = new StreamTranslator({
    dialect: g.clientKind,
    model,
    includeUsage:
      isRecord(clientBody.stream_options) && clientBody.stream_options.include_usage === true,
    messageIdSuffix: randomBytes(6).toString('hex'),
    driver,
    language: ctx.language,
    think: ctx.thinkTail.has(entry.spec.routeId, model) ? 'tail' : 'lead',
    shim:
      allowed.size > 0
        ? { allowed, aliases: vault.reverse(), priorCalls: historyHasToolUse(clientBody) }
        : undefined,
    placeholders: driver.placeholderPattern
      ? { pattern: driver.placeholderPattern, sent: guarded.body }
      : undefined,
  });
  const restore = new ResponseStreamFilter(g.clientKind, vault.reverse());
  const wantsStream = clientBody.stream === true;
  const response = g.response;
  let failure: string | undefined;
  let collected = 0;
  let overflow = false;

  if (wantsStream) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.flushHeaders();
  }
  try {
    const end = await pumpWithStall(
      upstream.body,
      ctx.stallMs,
      () => sent.abort.abort(new Error('stalled')),
      async (text) => {
        if (wantsStream) {
          await write(response, restore.push(translator.push(text)));
          return;
        }
        collected += Buffer.byteLength(text, 'utf8');
        if (collected > MAX_ANSWER_BYTES) overflow = true;
        else translator.push(text);
      },
      () => response.destroyed || overflow,
    );
    if (end === 'stalled')
      failure = hopText('hop-stalled', { seconds: Math.round(ctx.stallMs / 1_000) });
  } catch (error) {
    failure = hopText('gateway-answer-broken', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (wantsStream) {
    if (failure) finishBroken(response, translator, restore, failure);
    else if (!response.destroyed) response.end(restore.push(translator.end()) + restore.end());
  } else {
    translator.end();
    collectForClient(g, translator, vault, model, failure, overflow);
  }

  const facts = translator.facts;
  // `prompt_tokens` верха = свежий вход + прочитанное + записанное (`cache-usage.ts`): запись
  // вычитается из входа, иначе она считалась бы дважды — входом и записью (и деньгами тоже).
  const usage = {
    input: Math.max(facts.promptTokens - facts.cachedTokens - facts.cacheWriteTokens, 0),
    cacheRead: facts.cachedTokens,
    cacheWrite: facts.cacheWriteTokens,
    cacheWrite1h: facts.cacheWrite1hTokens,
    output: facts.completionTokens,
  };
  if (facts.totalTokens > 0) ctx.spend.add(entry.spec, model, usage, ctx.now());
  if (facts.summarized) {
    noteSummarized(ctx.stateDir, {
      at: new Date(ctx.now()).toISOString(),
      platformId: entry.spec.routeId,
      path: g.path,
      ...(anthropic && facts.messageId ? { messageId: facts.messageId } : {}),
      runTag: entry.spec.tag,
    });
  }
  if (facts.bareThinkClose) ctx.thinkTail.mark(entry.spec.routeId, model);
  const status = failure
    ? response.destroyed
      ? 499
      : busyStatus(g.clientKind)
    : facts.upstreamError
      ? statusOfErrorCode(facts.upstreamError.code)
      : facts.interrupted
        ? 400
        : facts.truncated
          ? 502
          : 200;
  traceOf(g, {
    status,
    masked: guarded.masked || facts.masked,
    tokens: facts.totalTokens,
    ...(lost.length ? { lost } : {}),
    ...(facts.violations.length ? { violations: facts.violations } : {}),
    ...(sent.reply.retried ? { retried: true } : {}),
    ...(failure ? { error: failure } : {}),
  });
}

/** Клиенту, которому уже льётся поток, беда сообщается кадром ошибки: молчание — «удачный ответ». */
function finishBroken(
  response: ServerResponse,
  translator: StreamTranslator,
  restore: ResponseStreamFilter,
  message: string,
): void {
  if (response.destroyed || response.writableEnded) return;
  response.end(restore.push(translator.fail(`AgentDeck: ${message}`)) + restore.end());
}

/** Клиент просил не поток: ответ собирается здесь и уходит цельным телом его диалекта. */
function collectForClient(
  g: GatewayRequest,
  translator: StreamTranslator,
  vault: AliasVault,
  model: string,
  failure: string | undefined,
  overflow: boolean,
): void {
  const { response, clientKind } = g;
  const language = translator.language;
  const fail = (status: number, message: string, code: string): void =>
    respondJson(response, status, errorBody(clientKind, `AgentDeck: ${message}`, code, language));
  if (overflow) return fail(413, hopText('gateway-answer-too-large'), 'request_too_large');
  if (failure) return fail(busyStatus(clientKind), failure, 'overloaded_error');
  const facts = translator.facts;
  if (facts.upstreamError)
    return fail(
      statusOfErrorCode(facts.upstreamError.code),
      hopText('gateway-upstream-aborted', { message: facts.upstreamError.message }),
      facts.upstreamError.code,
    );
  if (facts.interrupted) {
    const names = facts.violations.join(', ');
    const message = names
      ? hopText('gateway-checks-stopped-named', { names })
      : hopText('gateway-checks-stopped');
    return fail(400, message, 'content_policy_violation');
  }
  if (facts.truncated) return fail(502, translator.truncationMessage(), 'api_error');

  const answer = translator.assembled();
  const toolCalls = answer.calls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  }));
  const completion = {
    id: answer.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: answer.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content:
            answer.parts.length > 0
              ? [...(answer.text ? [{ type: 'text', text: answer.text }] : []), ...answer.parts]
              : answer.text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: answer.finishReason,
      },
    ],
    usage: openAiUsage(
      answer.promptTokens,
      answer.completionTokens,
      answer.totalTokens,
      answer.cache,
    ),
  };
  const body =
    clientKind === 'anthropic'
      ? openAiResponseToAnthropic(completion, answer.model || model)
      : completion;
  if (clientKind === 'anthropic' && isRecord(body) && typeof body.id === 'string')
    translator.facts.messageId = body.id;
  respondJson(response, 200, restoreJsonResponse(body, clientKind, vault.reverse()));
}
