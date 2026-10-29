/**
 * Клиент Anthropic Messages по документации «Streaming messages» — строгий: порядок
 * событий, имя события = `type` данных, индексы блоков подряд, дельта по типу блока,
 * ничего после `message_stop` и после события `error`, `stop_reason` и числа расхода
 * обязательны. Итог — сообщение в форме ответа без потока.
 */
import { argsJson, dataJson, parseSse } from './sse.ts';
import { usageWith, type Reply } from './reply.ts';

const EVENTS = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

type Block =
  { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string };

const fail = (why: string): never => {
  throw new Error(`anthropic stream: ${why}`);
};
const failJson = (why: string): never => {
  throw new Error(`anthropic json: ${why}`);
};

/** Число расхода, которое протокол обязан прислать; нет — провал, а не NaN в итоге. */
const tokens = (usage: unknown, field: string, onFail: (why: string) => never): number => {
  const value = (usage as Record<string, unknown> | undefined)?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value))
    onFail(`usage.${field} is not a number`);
  return value as number;
};

export function readAnthropicStream(text: string): Reply {
  const events = parseSse(text);
  const blocks: Block[] = [];
  let open: number | undefined;
  let started = false;
  let stopped = false;
  let stopReason: string | undefined;
  let usage = { input: 0, output: 0 };
  let cached: unknown;
  let id = '';
  for (const [at, event] of events.entries()) {
    if (stopped) fail(`event ${event.event} after message_stop`);
    if (!event.named || !EVENTS.has(event.event)) fail(`unexpected event name ${event.event}`);
    const data = dataJson(event);
    if (data.type !== event.event) fail(`event ${event.event} carries type ${String(data.type)}`);
    if (event.event === 'error') {
      const error = data.error as { type: string; message: string };
      if (typeof error?.type !== 'string' || typeof error.message !== 'string')
        fail('error event without error.type/message');
      // Ошибка посреди потока — последний кадр: после неё сервер поток рвёт.
      if (at !== events.length - 1) fail(`event ${events[at + 1]!.event} after the error event`);
      return { kind: 'error', midStream: true, type: error.type, message: error.message };
    }
    if (!started) {
      if (event.event !== 'message_start') fail(`first event is ${event.event}`);
      const message = data.message as Record<string, unknown>;
      if (
        message?.type !== 'message' ||
        message.role !== 'assistant' ||
        !Array.isArray(message.content)
      )
        fail('message_start without a message');
      id = String(message.id);
      usage.input = tokens(message.usage, 'input_tokens', fail);
      cached = (message.usage as Record<string, number>)?.cache_read_input_tokens;
      started = true;
      continue;
    }
    switch (event.event) {
      case 'ping':
        break;
      case 'message_start':
        fail('second message_start');
        break;
      case 'content_block_start': {
        if (open !== undefined) fail('block started while another is open');
        if (data.index !== blocks.length)
          fail(`block index ${String(data.index)}, expected ${blocks.length}`);
        const block = data.content_block as Record<string, unknown>;
        if (block?.type === 'text') blocks.push({ type: 'text', text: String(block.text ?? '') });
        else if (block?.type === 'tool_use') {
          if (typeof block.id !== 'string' || typeof block.name !== 'string')
            fail('tool_use without id/name');
          blocks.push({
            type: 'tool_use',
            id: block.id as string,
            name: block.name as string,
            json: '',
          });
        } else fail(`block type ${String(block?.type)}`);
        open = blocks.length - 1;
        break;
      }
      case 'content_block_delta': {
        if (open === undefined || data.index !== open) fail('delta for a block that is not open');
        const block = blocks[open as number]!;
        const delta = data.delta as Record<string, unknown>;
        if (block.type === 'text' && delta?.type === 'text_delta') block.text += String(delta.text);
        else if (block.type === 'tool_use' && delta?.type === 'input_json_delta')
          block.json += String(delta.partial_json);
        else fail(`delta ${String(delta?.type)} in a ${block.type} block`);
        break;
      }
      case 'content_block_stop':
        if (open === undefined || data.index !== open) fail('stop for a block that is not open');
        open = undefined;
        break;
      case 'message_delta': {
        if (open !== undefined) fail('message_delta while a block is open');
        const reason = (data.delta as Record<string, unknown> | undefined)?.stop_reason;
        if (typeof reason !== 'string') fail('message_delta without delta.stop_reason');
        stopReason = reason as string;
        usage = { ...usage, output: tokens(data.usage, 'output_tokens', fail) };
        break;
      }
      case 'message_stop':
        if (stopReason === undefined) fail('message_stop before message_delta');
        stopped = true;
        break;
    }
  }
  if (!stopped) fail('stream ended without message_stop');
  return {
    kind: 'message',
    id,
    stopReason: stopReason!,
    usage: usageWith(usage.input, usage.output, cached),
    parts: blocks.map((block) =>
      block.type === 'text'
        ? { kind: 'text' as const, text: block.text }
        : {
            kind: 'tool' as const,
            id: block.id,
            name: block.name,
            args: block.json ? argsJson(block.json, 'anthropic stream') : {},
          },
    ),
  };
}

export function readAnthropicJson(body: Record<string, unknown>): Reply {
  if (body.type === 'error') {
    const error = body.error as Record<string, unknown> | undefined;
    if (typeof error?.type !== 'string' || typeof error.message !== 'string')
      failJson('error body without error.type/message');
    return {
      kind: 'error',
      midStream: false,
      type: error!.type as string,
      message: error!.message as string,
    };
  }
  if (body.type !== 'message' || body.role !== 'assistant' || !Array.isArray(body.content))
    failJson('body is not a message');
  if (typeof body.stop_reason !== 'string') failJson('message without stop_reason');
  const usage = body.usage as Record<string, unknown> | undefined;
  return {
    kind: 'message',
    id: String(body.id),
    stopReason: body.stop_reason as string,
    usage: usageWith(
      tokens(usage, 'input_tokens', failJson),
      tokens(usage, 'output_tokens', failJson),
      usage?.cache_read_input_tokens,
    ),
    parts: (body.content as Record<string, unknown>[]).map((block) => {
      if (block.type === 'text') return { kind: 'text' as const, text: String(block.text) };
      if (block.type === 'tool_use')
        return {
          kind: 'tool' as const,
          id: String(block.id),
          name: String(block.name),
          args: block.input,
        };
      return failJson(`block type ${String(block.type)}`);
    }),
  };
}
