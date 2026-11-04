import type { AdapterEvent, PermissionAsk, RawToolCall, TurnUsage } from '../adapter.types.ts';
import { acpRemoteRefusal, type AcpMcpServer } from '../mcp-carry.ts';
import type { RpcDialect, RpcOut, RpcStep } from './rpc.types.ts';

/**
 * Диалект ACP (Agent Client Protocol, JSON-RPC 2.0 по stdio, версия протокола 1): `goose acp`
 * (1.54) и `opencode acp` (1.18), живые пробы 02.11 на stub-model. Рукопожатие: `initialize` →
 * `session/new` (рабочая папка + серверы MCP шага, `mcp-carry.ts`) → готов; продолжение — `session/load` того же id (агент
 * обязан объявить `loadSession`; разговор переходник уже положил в хранилище дома сеанса), история,
 * которую агент проигрывает уведомлениями до ответа, не становится событиями хода. Ход —
 * `session/prompt`; поток хода —
 * уведомления `session/update`; конец хода — ответ на НАШ `session/prompt` (тот же id запроса),
 * поэтому ход приписан своей отправке без догадок по порядку.
 *
 * Хук ядра живёт в самом CLI (плагин), диалект его не видит: отказ хука приходит как вызов со
 * статусом `failed` и текстом отказа. Вопрос о праве (`session/request_permission`) решает ядро
 * (`permit.request`); ответ — вариант `allow_once`/`reject_once`, никогда «разрешить всегда».
 */

export interface AcpDialectInput {
  /** Имя CLI в текстах ошибок. */
  cli: string;
  cwd: string;
  permit: 'core' | 'refuse';
  mapPermission(raw: RawToolCall): PermissionAsk;
  /** Имя инструмента вызова так, как его видят хук ядра и судья (первое событие вызова). */
  toolName(call: Record<string, unknown>): string;
  model?: string;
  /** Проверка ответа `session/new` (режим права, модель): строка — рукопожатие сорвано. */
  checkSession?(result: Record<string, unknown>): string | null;
  /** Разговор, который продолжаем (`session/load`), вместо нового. */
  load?: string;
  /** Серверы MCP шага (`acpMcpServers`): уходят и в `session/new`, и в `session/load`. */
  mcpServers?: AcpMcpServer[];
  /** Проверка ответа `session/load`; нет — та же, что у `session/new`. */
  checkLoad?(result: Record<string, unknown>): string | null;
}

/** Вход диалекта данными (без функций переходника): его запуск кладёт в `rpc-view.json`. */
export type AcpDialectData = Omit<
  AcpDialectInput,
  'mapPermission' | 'toolName' | 'checkSession' | 'checkLoad'
>;

/**
 * Вход для диска: разбор читает у серверов MCP только имя и транспорт (`acpRemoteRefusal`) —
 * команда, аргументы, адрес, env и заголовки (там бывают ключи) в каталог сеанса не пишутся.
 */
export function acpViewInput(data: AcpDialectData): AcpDialectData {
  if (!data.mcpServers) return data;
  return {
    ...data,
    mcpServers: data.mcpServers.map((s) =>
      'type' in s
        ? { type: s.type, name: s.name, url: '', headers: [] }
        : { name: s.name, command: '', args: [], env: [] },
    ),
  };
}

interface Message {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface ToolState {
  name: string;
  input: Record<string, unknown>;
  requested: boolean;
  done: boolean;
}

interface PendingAsk {
  rpcId: number | string;
  options: { optionId: string; kind: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Вход вызова «по существу»: opencode шлёт сначала только `cwd`, команду — следующим событием. */
const substantive = (input: Record<string, unknown>): boolean =>
  Object.keys(input).some((k) => k !== 'cwd');

/** Текст содержимого вызова (`content[].content.text`): причина отказа хука или сбоя. */
function contentText(update: Record<string, unknown>): string {
  const content = Array.isArray(update.content) ? (update.content as unknown[]) : [];
  return content
    .map((c) => (isRecord(c) && isRecord(c.content) ? str(c.content.text) : ''))
    .filter(Boolean)
    .join('\n');
}

/** Код выхода команды: goose `rawOutput.exit_code`, opencode `rawOutput.metadata.exit`. */
function exitCodeOf(update: Record<string, unknown>): number | null {
  const raw = isRecord(update.rawOutput) ? update.rawOutput : {};
  if (typeof raw.exit_code === 'number') return raw.exit_code;
  const meta = isRecord(raw.metadata) ? raw.metadata : {};
  return typeof meta.exit === 'number' ? meta.exit : null;
}

export function createAcpDialect(input: AcpDialectInput): RpcDialect {
  let nextId = 1;
  const waiting = new Map<number, (msg: Message) => RpcStep>();
  let failed: string | null = null;
  let sessionId: string | null = null;
  let ready = false;
  /** Идёт `session/load`: проигрыш истории — не события хода. */
  let loading = false;
  /** Ход в работе: uuid отправки, начат ли, текст последнего сообщения модели. */
  let turn: {
    uuid: string;
    cmdId: string;
    started: boolean;
    text: string;
    messageId: string;
  } | null = null;
  const byCmd = new Map<string, number>();
  const tools = new Map<string, ToolState>();
  const asks = new Map<string, PendingAsk>();
  const usages: TurnUsage[] = [];
  let usageSeq = 0;

  const step = (events: AdapterEvent[] = [], out: RpcOut[] = []): RpcStep => ({ events, out });
  const line = (msg: Record<string, unknown>): string => JSON.stringify({ jsonrpc: '2.0', ...msg });
  const request = (
    method: string,
    params: Record<string, unknown>,
    then: (msg: Message) => RpcStep,
  ): RpcOut => {
    const id = nextId++;
    waiting.set(id, then);
    return { key: `rpc:${id}`, line: line({ id, method, params }) };
  };
  const fail = (reason: string): RpcStep => {
    failed = reason;
    ready = false;
    return step([
      { type: 'error', code: 'protocol', detail: `${input.cli} acp handshake: ${reason}` },
    ]);
  };

  /** Первое событие потока после отправки — ход начат (ответ придёт на наш же запрос). */
  const startTurn = (): AdapterEvent[] => {
    if (!turn || turn.started) return [];
    turn.started = true;
    return [{ type: 'turn.started', attribution: turn.uuid, origin: 'echo' }];
  };

  const newSession = (): RpcOut =>
    request('session/new', { cwd: input.cwd, mcpServers: input.mcpServers ?? [] }, (msg) => {
      const id = str(msg.result?.sessionId);
      if (msg.error || !id) return fail(`session/new: ${msg.error?.message ?? 'no session id'}`);
      const refused = input.checkSession?.(msg.result ?? {}) ?? null;
      if (refused) return fail(`session/new: ${refused}`);
      sessionId = id;
      ready = true;
      return step([
        { type: 'init', conversationId: id, model: input.model ?? '', tools: [], mcp: [] },
      ]);
    });

  const loadSession = (id: string): RpcOut => {
    loading = true;
    return request(
      'session/load',
      { sessionId: id, cwd: input.cwd, mcpServers: input.mcpServers ?? [] },
      (msg) => {
        loading = false;
        if (msg.error) return fail(`session/load: ${msg.error.message ?? 'error'}`);
        const check = input.checkLoad ?? input.checkSession;
        const refused = check?.(msg.result ?? {}) ?? null;
        if (refused) return fail(`session/load: ${refused}`);
        sessionId = id;
        ready = true;
        return step([
          { type: 'init', conversationId: id, model: input.model ?? '', tools: [], mcp: [] },
        ]);
      },
    );
  };

  const requested = (id: string, state: ToolState): AdapterEvent[] => {
    if (state.requested) return [];
    state.requested = true;
    return [
      {
        type: 'tool.requested',
        toolUseId: id,
        name: state.name,
        input: state.input,
        cliInitiated: false,
        parentToolUseId: null,
      },
    ];
  };

  const onToolUpdate = (update: Record<string, unknown>, first: boolean): AdapterEvent[] => {
    const id = str(update.toolCallId);
    if (!id) return [];
    let state = tools.get(id);
    if (!state) {
      state = { name: input.toolName(update), input: {}, requested: false, done: false };
      tools.set(id, state);
    }
    if (isRecord(update.rawInput) && substantive(update.rawInput)) state.input = update.rawInput;
    const events: AdapterEvent[] = [...startTurn()];
    const status = str(update.status);
    const terminal = status === 'completed' || status === 'failed';
    if (substantive(state.input) || terminal || (first && status !== 'pending')) {
      events.push(...requested(id, state));
    }
    if (terminal && !state.done) {
      state.done = true;
      const exitCode = exitCodeOf(update);
      const errorText = status === 'failed' ? contentText(update) || null : null;
      events.push({
        type: 'tool.result',
        toolUseId: id,
        isError: status === 'failed' || (exitCode !== null && exitCode !== 0),
        cliInitiated: false,
        outcome: { exitCode, errorText, bytes: null },
      });
    }
    return events;
  };

  const endTurn = (isError: boolean, error: string | null, usage?: unknown): AdapterEvent[] => {
    const current = turn;
    turn = null;
    if (!current) return [];
    const events: AdapterEvent[] = [];
    if (!current.started) {
      events.push({ type: 'turn.started', attribution: current.uuid, origin: 'echo' });
    }
    if (isRecord(usage)) {
      usageSeq += 1;
      const cacheRead = num(usage.cachedReadTokens);
      const entry: TurnUsage = {
        messageId: `${current.uuid}:${usageSeq}`,
        input: Math.max(0, num(usage.inputTokens) - cacheRead),
        cacheRead,
        cacheWrite: num(usage.cachedWriteTokens),
        output: num(usage.outputTokens),
        ...(input.model ? { model: input.model } : {}),
      };
      usages.push(entry);
      events.push({ type: 'usage', ...entry });
    }
    events.push({
      type: 'turn.ended',
      attribution: current.uuid,
      origin: 'echo',
      isError,
      numTurns: 1,
      text: error ?? current.text,
    });
    byCmd.delete(current.cmdId);
    return events;
  };

  const onRequest = (msg: Message): RpcStep => {
    const rpcId = msg.id as number | string;
    const params = msg.params ?? {};
    if (msg.method !== 'session/request_permission') {
      // fs/terminal клиенту не объявлены; прочее ядро не знает — отказ ошибкой, не молчание.
      return step(
        [],
        [
          {
            key: `reply:${String(rpcId)}`,
            line: line({
              id: rpcId,
              error: {
                code: -32601,
                message: `agentdeck core does not answer ${String(msg.method)}`,
              },
            }),
          },
        ],
      );
    }
    const call = isRecord(params.toolCall) ? params.toolCall : {};
    const id = str(call.toolCallId);
    const known = tools.get(id);
    const rawInput = isRecord(call.rawInput) && substantive(call.rawInput) ? call.rawInput : null;
    const raw = {
      tool_name: known?.name ?? input.toolName(call),
      input: rawInput ?? known?.input ?? {},
      tool_use_id: id,
    };
    const options = (Array.isArray(params.options) ? (params.options as unknown[]) : [])
      .filter(isRecord)
      .map((o) => ({ optionId: str(o.optionId), kind: str(o.kind) }));
    const events: AdapterEvent[] = [...startTurn()];
    if (input.permit === 'refuse' || !id) {
      const ask = input.mapPermission({ tool: raw.tool_name, input: raw.input });
      events.push({ type: 'ask', ask, denied: true, ...(id ? { toolUseId: id } : {}) });
      return step(events, [
        {
          key: `reply:${String(rpcId)}`,
          line: line({ id: rpcId, result: rejectOutcome(options) }),
        },
      ]);
    }
    const requestId = `${input.cli}:${String(rpcId)}`;
    asks.set(requestId, { rpcId, options });
    events.push({ type: 'permit.request', requestId, raw });
    return step(events);
  };

  const onUpdate = (params: Record<string, unknown>): RpcStep => {
    // Проигрыш продолжаемого разговора: прошлые вызовы и ответы — не новый ход.
    if (loading) return step();
    if (sessionId !== null && str(params.sessionId) !== sessionId) return step();
    const update = isRecord(params.update) ? params.update : {};
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = isRecord(update.content) ? update.content : {};
        const text = content.type === 'text' ? str(content.text) : '';
        if (!text || !turn) return step();
        const events = startTurn();
        const messageId = str(update.messageId);
        if (messageId && messageId !== turn.messageId) {
          turn.messageId = messageId;
          turn.text = '';
        }
        turn.text += text;
        return step([...events, { type: 'text.delta', text }]);
      }
      case 'tool_call':
        return step(onToolUpdate(update, true));
      case 'tool_call_update':
        return step(onToolUpdate(update, false));
      default:
        return step();
    }
  };

  return {
    start: () => [
      request(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'agentdeck-core', version: '1' },
        },
        (msg) => {
          if (msg.error) return fail(`initialize: ${msg.error.message ?? 'error'}`);
          if (msg.result?.protocolVersion !== 1) {
            return fail(`initialize: protocol ${String(msg.result?.protocolVersion)}, expected 1`);
          }
          const caps = isRecord(msg.result?.agentCapabilities) ? msg.result.agentCapabilities : {};
          // Удалённый сервер шага при необъявленном транспорте — отказ, не молчаливая потеря (s10 p8).
          const remote = acpRemoteRefusal(input.mcpServers ?? [], caps);
          if (remote) return fail(`initialize: ${remote}`);
          if (input.load === undefined) return step([], [newSession()]);
          // Без объявленного `loadSession` продолжать нечем: новый разговор под старым id — ложь.
          if (caps.loadSession !== true)
            return fail('initialize: agent does not declare loadSession');
          return step([], [loadSession(input.load)]);
        },
      ),
    ],

    push(text) {
      let msg: Message;
      try {
        msg = JSON.parse(text) as Message;
      } catch {
        return step([
          {
            type: 'error',
            code: 'protocol',
            detail: `${input.cli} stdout is not JSON: ${text.slice(0, 200)}`,
          },
        ]);
      }
      if (!isRecord(msg)) return step();
      if (msg.method && msg.id !== undefined) return onRequest(msg);
      if (msg.method === 'session/update')
        return onUpdate((msg.params ?? {}) as Record<string, unknown>);
      if (msg.method) return step();
      if (typeof msg.id === 'number') {
        const then = waiting.get(msg.id);
        if (!then) return step();
        waiting.delete(msg.id);
        return then(msg);
      }
      return step();
    },

    get ready() {
      return ready && failed === null && turn === null;
    },

    get failed() {
      return failed;
    },

    turn(text, cmdId, uuid) {
      turn = { uuid, cmdId, started: false, text: '', messageId: '' };
      const out = request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        (msg) => {
          if (msg.error) {
            return step(endTurn(true, `session/prompt: ${msg.error.message ?? 'error'}`));
          }
          const reason = str(msg.result?.stopReason);
          return step(
            endTurn(
              reason !== 'end_turn',
              reason === 'end_turn' ? null : `stopped: ${reason || 'no stop reason'}`,
              msg.result?.usage,
            ),
          );
        },
      );
      byCmd.set(cmdId, Number(out.key.slice('rpc:'.length)));
      return { key: cmdId, line: out.line };
    },

    forget(cmdId) {
      const id = byCmd.get(cmdId);
      if (id !== undefined) waiting.delete(id);
      byCmd.delete(cmdId);
      if (turn?.cmdId === cmdId) turn = null;
    },

    retract(cmdId) {
      const id = byCmd.get(cmdId);
      this.forget(cmdId);
      // Между turn() и сбоем записи насос синхронен — этот id последний выданный.
      if (id !== undefined && id === nextId - 1) nextId = id;
    },

    answer(requestId, reply) {
      const ask = asks.get(requestId);
      if (!ask) return undefined;
      asks.delete(requestId);
      const allow = acpDecision(reply) === 'accept';
      const once = ask.options.find((o) => o.kind === 'allow_once');
      return {
        key: `permit:${requestId}`,
        line: line({
          id: ask.rpcId,
          result:
            allow && once
              ? { outcome: { outcome: 'selected', optionId: once.optionId } }
              : rejectOutcome(ask.options),
        }),
      };
    },

    get conversationId() {
      return sessionId;
    },

    usage: () => [...usages],
  };
}

/** Отказ: вариант `reject_once`, нет его — отмена вопроса (вызов не исполняется). */
function rejectOutcome(options: { optionId: string; kind: string }[]): Record<string, unknown> {
  const reject = options.find((o) => o.kind === 'reject_once');
  return reject
    ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** Ответ ядра в форме кодека (`{decision}`): только целое `accept` разрешает; прочее — отказ. */
export function acpDecision(reply: unknown): 'accept' | 'decline' {
  const decision =
    typeof reply === 'object' && reply !== null ? (reply as { decision?: unknown }).decision : null;
  return decision === 'accept' ? 'accept' : 'decline';
}
