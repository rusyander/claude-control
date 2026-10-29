/**
 * Клиент OpenAI Responses по справке «Streaming responses» — строгий: имя события =
 * `type`, `sequence_number` подряд с нуля, первым `response.created`, у каждого
 * элемента вывода `added` → дельты → `done` по его `item_id`, итог `.done` равен
 * собранным дельтам, `response.completed` несёт тот же `output`, после него — ничего.
 * Дельта своего вида (текст / аргументы / свободный ввод) — только элементу своего типа;
 * `response.failed` несёт `error.code` строкой.
 */
import { argsJson, dataJson, parseSse } from './sse.ts';
import { usageWith, type Reply, type ReplyPart } from './reply.ts';

const EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.output_item.added',
  'response.content_part.added',
  'response.output_text.delta',
  'response.output_text.done',
  'response.content_part.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.custom_tool_call_input.delta',
  'response.custom_tool_call_input.done',
  'response.output_item.done',
  'response.completed',
  'response.failed',
]);

const fail = (why: string): never => {
  throw new Error(`openai-responses stream: ${why}`);
};
const failJson = (why: string): never => {
  throw new Error(`openai-responses json: ${why}`);
};

type Item = Record<string, unknown>;

/** Какой тип элемента вывода кормит событие дельты/итога/части (по справке). */
const ITEM_OF: Record<string, string> = {
  'response.content_part.added': 'message',
  'response.content_part.done': 'message',
  'response.output_text.delta': 'message',
  'response.output_text.done': 'message',
  'response.function_call_arguments.delta': 'function_call',
  'response.function_call_arguments.done': 'function_call',
  'response.custom_tool_call_input.delta': 'custom_tool_call',
  'response.custom_tool_call_input.done': 'custom_tool_call',
};

export function readResponsesStream(text: string): Reply {
  const events = parseSse(text);
  let seq = 0;
  let id: string | undefined;
  let terminal: Item | undefined;
  let failed: Item | undefined;
  const done: Item[] = [];
  let open: { item: Item; index: number; acc: string } | undefined;
  for (const event of events) {
    if (terminal || failed) fail(`event ${event.event} after the terminal event`);
    if (!event.named || !EVENTS.has(event.event)) fail(`unexpected event ${event.event}`);
    const data = dataJson(event);
    if (data.type !== event.event) fail(`event ${event.event} carries type ${String(data.type)}`);
    if (data.sequence_number !== seq)
      fail(`sequence_number ${String(data.sequence_number)}, expected ${seq}`);
    seq += 1;
    if (id === undefined) {
      if (event.event !== 'response.created') fail(`first event ${event.event}`);
      id = String((data.response as Item).id);
      continue;
    }
    // Дельта, итог и часть — только открытому элементу, по его `item_id` и `output_index`
    // (настоящий поток несёт оба всегда), и только элементу своего типа.
    const kind = ITEM_OF[event.event];
    if (kind !== undefined) {
      if (!open || data.item_id !== open.item.id || data.output_index !== open.index)
        fail(`${event.event} for an item that is not open`);
      if (open!.item.type !== kind) fail(`${event.event} inside a ${String(open!.item.type)} item`);
    }
    switch (event.event) {
      case 'response.in_progress':
        break;
      case 'response.output_item.added':
        if (open) fail('item added while another is open');
        if (data.output_index !== done.length) fail(`output_index ${String(data.output_index)}`);
        open = { item: data.item as Item, index: done.length, acc: '' };
        break;
      case 'response.content_part.added':
      case 'response.content_part.done':
        break;
      case 'response.output_text.delta':
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        if (typeof data.delta !== 'string') fail(`${event.event} without a string delta`);
        open!.acc += data.delta as string;
        break;
      case 'response.output_text.done':
        if (data.text !== open!.acc) fail('output_text.done differs from the deltas');
        break;
      case 'response.function_call_arguments.done':
        if (data.arguments !== open!.acc) fail('arguments.done differs from the deltas');
        break;
      case 'response.custom_tool_call_input.done':
        if (data.input !== open!.acc) fail('custom input.done differs from the deltas');
        break;
      case 'response.output_item.done': {
        const item = data.item as Item;
        if (!open || item.id !== open.item.id || data.output_index !== open.index)
          fail('item done without added');
        const final =
          item.type === 'message'
            ? (item.content as Item[]).map((part) => String(part.text)).join('')
            : item.type === 'function_call'
              ? String(item.arguments)
              : String(item.input);
        if (final !== open!.acc) fail(`item ${String(item.id)} differs from its deltas`);
        done.push(item);
        open = undefined;
        break;
      }
      case 'response.completed':
        if (open) fail('completed while an item is open');
        terminal = data.response as Item;
        break;
      case 'response.failed':
        failed = (data.response as Item | undefined) ?? fail('response.failed without response');
        break;
    }
  }
  if (failed) {
    // `response.error` по справке — `{code, message}`; тип ответа ядру — код.
    const error = failed.error as Item | null | undefined;
    if (!error || typeof error !== 'object') fail('response.failed without response.error');
    if (typeof error!.code !== 'string' || typeof error!.message !== 'string')
      fail('response.failed without error.code/message');
    return {
      kind: 'error',
      midStream: true,
      type: error!.code as string,
      message: error!.message as string,
    };
  }
  if (!terminal) fail('stream ended without response.completed');
  if (terminal!.id !== id || terminal!.status !== 'completed') fail('completed response id/status');
  if (JSON.stringify(terminal!.output) !== JSON.stringify(done))
    fail('completed.output differs from the done items');
  return toReply(terminal!);
}

function toReply(response: Item, onFail: (why: string) => never = fail): Reply {
  const usage = response.usage as Record<string, unknown> | null | undefined;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  if (typeof input !== 'number' || typeof output !== 'number')
    onFail('usage without input_tokens/output_tokens');
  if (usage!.total_tokens !== (input as number) + (output as number))
    onFail('usage total mismatch');
  if (!Array.isArray(response.output)) onFail('response without output');
  const parts: ReplyPart[] = (response.output as Item[]).map((item) => {
    if (item.type === 'message')
      return {
        kind: 'text',
        text: (item.content as Item[]).map((part) => String(part.text)).join(''),
      };
    if (item.type === 'function_call')
      return {
        kind: 'tool',
        id: String(item.call_id),
        name: String(item.name),
        args: argsJson(String(item.arguments), 'openai-responses'),
      };
    if (item.type === 'custom_tool_call')
      return {
        kind: 'custom',
        id: String(item.call_id),
        name: String(item.name),
        input: String(item.input),
      };
    return onFail(`output item type ${String(item.type)}`);
  });
  return {
    kind: 'message',
    id: String(response.id),
    stopReason: String(response.status),
    usage: usageWith(
      input as number,
      output as number,
      (usage!.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens,
    ),
    parts,
  };
}

/**
 * Ошибка HTTP — конверт OpenAI `{message, type, param, code}`: `code` часто `null`, поэтому
 * тип ответа — `type`, строкой обязательно (раньше читался `code`, и `String(null)` проходил).
 */
export function readResponsesJson(body: Record<string, unknown>): Reply {
  if (body.error) {
    const error = body.error as Item;
    if (typeof error.type !== 'string' || typeof error.message !== 'string')
      failJson('error body without error.type/message');
    return {
      kind: 'error',
      midStream: false,
      type: error.type as string,
      message: error.message as string,
    };
  }
  if (body.object !== 'response' || body.status !== 'completed')
    failJson('body is not a completed response');
  return toReply(body, failJson);
}
