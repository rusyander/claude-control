/**
 * Клиент OpenAI Chat Completions по справке «Streaming» — строгий: события без
 * имени, каждое `data:` — чанк `chat.completion.chunk` с одним id, вызов
 * инструмента собирается по `index` (первый фрагмент несёт id, type, имя), ровно
 * один `finish_reason`, чанк расхода (пустой `choices`) только после него, конец —
 * `[DONE]`. Ошибка посреди потока — чанк `{error}` (тип — строкой) последним кадром,
 * обрыв без `[DONE]`. `finish_reason: tool_calls` — только с вызовами.
 */
import { argsJson, dataJson, parseSse } from './sse.ts';
import { usageWith, type Reply, type ReplyPart, type Usage } from './reply.ts';

/** Кеш по справке: `usage.prompt_tokens_details.cached_tokens` (входит в `prompt_tokens`). */
const cachedOf = (usage: Record<string, unknown>) =>
  (usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;

const fail = (why: string): never => {
  throw new Error(`openai-chat stream: ${why}`);
};
const failJson = (why: string): never => {
  throw new Error(`openai-chat json: ${why}`);
};

/**
 * Ошибка в форме OpenAI `{message, type, …}`: тип — строкой, иначе провал (раньше
 * `String(undefined)` давал тип «undefined», и проверка типа ошибки не могла покраснеть).
 */
function errorOf(raw: unknown, onFail: (why: string) => never): { type: string; message: string } {
  const error = raw as Record<string, unknown> | undefined;
  if (typeof error?.message !== 'string') onFail('error without error.message');
  if (typeof error!.type !== 'string') onFail('error without error.type');
  return { type: error!.type as string, message: error!.message as string };
}

/** Расход по справке: числа, `total_tokens` — сумма. */
function usageOf(raw: unknown, onFail: (why: string) => never): Usage {
  const usage = raw as Record<string, unknown> | undefined;
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number')
    onFail('usage without prompt_tokens/completion_tokens');
  if (usage!.total_tokens !== (prompt as number) + (completion as number))
    onFail('usage total mismatch');
  return usageWith(prompt as number, completion as number, cachedOf(usage!));
}

interface Call {
  id: string;
  name: string;
  args: string;
}

export function readChatStream(text: string): Reply {
  const events = parseSse(text);
  let id: string | undefined;
  let role: string | undefined;
  let content = '';
  const calls: Call[] = [];
  let finish: string | undefined;
  let usage: Usage | undefined;
  let done = false;
  for (const [at, event] of events.entries()) {
    if (done) fail('data after [DONE]');
    if (event.named) fail(`named event ${event.event} in a chat stream`);
    if (event.data === '[DONE]') {
      done = true;
      continue;
    }
    const chunk = dataJson(event);
    if (chunk.error) {
      const error = errorOf(chunk.error, fail);
      // Обрыв без `[DONE]` и без других кадров — то, что обещает заголовок файла.
      if (at !== events.length - 1) fail('a frame after the error chunk');
      return { kind: 'error', midStream: true, ...error };
    }
    if (chunk.object !== 'chat.completion.chunk') fail(`object ${String(chunk.object)}`);
    if (id === undefined) id = String(chunk.id);
    else if (chunk.id !== id) fail('chunk id changed mid-stream');
    const choices = chunk.choices as Record<string, unknown>[];
    if (!Array.isArray(choices)) fail('chunk without choices');
    if (chunk.usage) {
      // Расход — только в конце: отдельным чанком с пустым `choices` (include_usage) или
      // на чанке с `finish_reason` (llama-server); на чанке содержимого — провал.
      const last = choices[0]?.finish_reason;
      if (choices.length > 0 && (last === null || last === undefined))
        fail('usage on a chunk before the end');
      usage = usageOf(chunk.usage, fail);
    }
    if (choices.length === 0) {
      if (!chunk.usage) fail('empty choices without usage');
      if (finish === undefined) fail('usage chunk before finish_reason');
      continue;
    }
    if (finish !== undefined) fail('choice chunk after finish_reason');
    const choice = choices[0]!;
    if (choice.index !== 0) fail(`choice index ${String(choice.index)}`);
    const delta = choice.delta as Record<string, unknown>;
    if (!delta || typeof delta !== 'object') fail('choice without delta');
    if (delta.role !== undefined) {
      if (role !== undefined) fail('role sent twice');
      role = String(delta.role);
    }
    if (typeof delta.content === 'string') content += delta.content;
    for (const piece of (delta.tool_calls as Record<string, unknown>[] | undefined) ?? []) {
      const at = piece.index as number;
      const fn = piece.function as Record<string, unknown> | undefined;
      if (at === calls.length) {
        if (
          typeof piece.id !== 'string' ||
          piece.type !== 'function' ||
          typeof fn?.name !== 'string'
        )
          fail('first tool_call fragment without id/type/name');
        calls.push({
          id: piece.id as string,
          name: fn!.name as string,
          args: String(fn!.arguments ?? ''),
        });
      } else if (at < calls.length) {
        if (piece.id !== undefined || fn?.name !== undefined) fail('tool_call id/name repeated');
        calls[at]!.args += String(fn?.arguments ?? '');
      } else fail(`tool_call index ${at} skips ahead`);
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined)
      finish = String(choice.finish_reason);
  }
  if (!done) fail('stream ended without [DONE]');
  if (role !== 'assistant') fail(`role ${String(role)}`);
  if (finish === undefined) fail('no finish_reason');
  if (calls.length && finish !== 'tool_calls') fail(`finish ${finish} with tool calls`);
  if (!calls.length && finish === 'tool_calls') fail('finish tool_calls without a tool call');
  const parts: ReplyPart[] = [];
  if (content) parts.push({ kind: 'text', text: content });
  for (const call of calls)
    parts.push({
      kind: 'tool',
      id: call.id,
      name: call.name,
      args: argsJson(call.args, 'openai-chat stream'),
    });
  return { kind: 'message', id: id!, stopReason: finish!, ...(usage ? { usage } : {}), parts };
}

export function readChatJson(body: Record<string, unknown>): Reply {
  if (body.error) return { kind: 'error', midStream: false, ...errorOf(body.error, failJson) };
  if (body.object !== 'chat.completion') failJson(`object ${String(body.object)}`);
  const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as
    Record<string, unknown> | undefined;
  if (!choice) failJson('completion without choices');
  const message = choice!.message as Record<string, unknown> | undefined;
  if (message?.role !== 'assistant') failJson('message role');
  if (typeof choice!.finish_reason !== 'string') failJson('choice without finish_reason');
  const parts: ReplyPart[] = [];
  if (typeof message!.content === 'string' && message!.content)
    parts.push({ kind: 'text', text: message!.content });
  const calls = (message!.tool_calls as Record<string, unknown>[] | undefined) ?? [];
  for (const call of calls) {
    const fn = call.function as Record<string, unknown> | undefined;
    if (call.type !== 'function') failJson('tool call type');
    if (typeof fn?.name !== 'string' || typeof fn.arguments !== 'string')
      failJson('tool call without function name/arguments');
    parts.push({
      kind: 'tool',
      id: String(call.id),
      name: fn!.name as string,
      args: argsJson(fn!.arguments as string, 'openai-chat json'),
    });
  }
  const finish = choice!.finish_reason as string;
  if (calls.length && finish !== 'tool_calls') failJson(`finish ${finish} with tool calls`);
  if (!calls.length && finish === 'tool_calls') failJson('finish tool_calls without a tool call');
  return {
    kind: 'message',
    id: String(body.id),
    stopReason: finish,
    usage: usageOf(body.usage, failJson),
    parts,
  };
}
