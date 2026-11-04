import type { PermitCodec } from './adapter.types.ts';
import type { RpcDialect } from './rpc-stdio/rpc.types.ts';
import { SDK_PERMIT_CODEC } from './sdk-stream/permit-codec.ts';

/**
 * Вход вызова для диалекта ACP там, где CLI не шлёт `rawInput` (живые пробы 02.11): Gemini CLI
 * 0.66 кладёт команду оболочки в `title`, путь правки — в `content[{type:'diff', path}]`; Kimi
 * Code 2.4.1 присылает аргументы текстом JSON в `content` первого `tool_call_update`, а
 * `rawInput` — только после одобрения. Судья права и журнал без входа видят пустой вызов, поэтому
 * строка дополняется входом ДО общего диалекта (`rpc-stdio/acp.ts`), сам диалект не меняется.
 */

export type AcpInputFill = (call: Record<string, unknown>) => Record<string, unknown> | null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const substantive = (v: unknown): boolean => isRecord(v) && Object.keys(v).some((k) => k !== 'cwd');

/** Дополняет вызов входом, если CLI его не дал; вызов с настоящим `rawInput` не трогается. */
function filled(call: Record<string, unknown>, fill: AcpInputFill): boolean {
  if (substantive(call.rawInput)) return false;
  const input = fill(call);
  if (!input || !substantive(input)) return false;
  call.rawInput = input;
  return true;
}

/** Строка протокола с дополненным входом (та же строка, если дополнять нечего). */
export function fillAcpLine(line: string, fill: AcpInputFill): string {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(msg) || !isRecord(msg.params)) return line;
  const params = msg.params;
  let changed = false;
  if (msg.method === 'session/update' && isRecord(params.update)) {
    const kind = params.update.sessionUpdate;
    if (kind === 'tool_call' || kind === 'tool_call_update') changed = filled(params.update, fill);
  } else if (msg.method === 'session/request_permission' && isRecord(params.toolCall)) {
    changed = filled(params.toolCall, fill);
  }
  return changed ? JSON.stringify(msg) : line;
}

/** Диалект ACP, получающий строки с дополненным входом; прочее — как у обёрнутого. */
export function withAcpInput(dialect: RpcDialect, fill: AcpInputFill): RpcDialect {
  return {
    start: () => dialect.start(),
    push: (line) => dialect.push(fillAcpLine(line, fill)),
    get ready() {
      return dialect.ready;
    },
    get failed() {
      return dialect.failed;
    },
    turn: (text, cmdId, uuid) => dialect.turn(text, cmdId, uuid),
    forget: (cmdId) => dialect.forget(cmdId),
    retract: (cmdId) => dialect.retract(cmdId),
    answer: (requestId, reply) => dialect.answer(requestId, reply),
    get conversationId() {
      return dialect.conversationId;
    },
    usage: () => dialect.usage(),
  };
}

/** Текст первого блока `content[].content.text` вызова (Kimi: аргументы JSON). */
export function acpContentText(call: Record<string, unknown>): string {
  const content = Array.isArray(call.content) ? (call.content as unknown[]) : [];
  for (const c of content) {
    if (isRecord(c) && isRecord(c.content) && typeof c.content.text === 'string') {
      if (c.content.text) return c.content.text;
    }
  }
  return '';
}

/** Путь первой правки `content[{type:'diff', path}]` или первого места `locations[{path}]`. */
export function acpPathOf(call: Record<string, unknown>): string {
  const content = Array.isArray(call.content) ? (call.content as unknown[]) : [];
  for (const c of content) {
    if (isRecord(c) && c.type === 'diff' && typeof c.path === 'string' && c.path) return c.path;
  }
  const locations = Array.isArray(call.locations) ? (call.locations as unknown[]) : [];
  for (const l of locations) {
    if (isRecord(l) && typeof l.path === 'string' && l.path) return l.path;
  }
  return '';
}

/**
 * Вопрос о праве ACP диалект отдаёт формой `{tool_name, input, tool_use_id}` (чтение — общее с
 * каркасом SDK); ответ — `{decision}`, диалект переводит его в вариант `allow_once`/`reject_once`.
 */
export const ACP_PERMIT_CODEC: PermitCodec = {
  read: SDK_PERMIT_CODEC.read,
  render: (answer) => ({ decision: answer.allow ? 'accept' : 'decline' }),
};
