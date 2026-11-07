import type { AdapterEvent, PermissionAsk, RawToolCall, TurnUsage } from '../adapter.types.ts';
import type { RpcDialect, RpcOut, RpcStep } from '../rpc-stdio/rpc.types.ts';
import type { CodexApprovalPolicy, CodexSandboxMode } from '@agentdeck/contracts/permissions';
import { codexDecision, unwrapCodexShell } from './permission.ts';

/**
 * Диалект `codex app-server` (JSON-RPC по stdio без поля `jsonrpc`, codex-cli 0.155.1, живые
 * пробы 02.11). Рукопожатие: `initialize` → `initialized` → `hooks/list` → доверие хуку ядра
 * (`config/batchWrite` в `hooks.state` дома сеанса) → `thread/start` (продолжение — `thread/resume`
 * той же нити: её файл переходник уже положил в дом сеанса). Хук, который Codex не
 * показал или не доверил, — сеанс без политики: рукопожатие срывается, отправки отказываются.
 */

export interface CodexDialectInput {
  cwd: string;
  /** Команда хука ядра ровно так, как она записана в `hooks.json` сеанса. */
  hookCommand: string;
  /** Подмножество словаря панели: переименование значения там роняет tsc ядра, а не рукопожатие. */
  approvalPolicy: Extract<CodexApprovalPolicy, 'untrusted' | 'never'>;
  sandbox: Extract<CodexSandboxMode, 'read-only' | 'workspace-write'>;
  developerInstructions: string;
  model?: string;
  effort?: string;
  /** Нить, которую продолжаем (`thread/resume`): её файл уже лежит в доме сеанса. */
  resume?: string;
  /** Сеанс без следа (`SessionSpec.ephemeral`, замер базы): нить эфемерная, файла разговора нет. */
  ephemeral?: true;
  permit: 'core' | 'refuse';
  mapPermission(raw: RawToolCall): PermissionAsk;
}

/** Вход диалекта данными (без функций переходника): его запуск кладёт в `rpc-view.json`. */
export type CodexDialectData = Omit<CodexDialectInput, 'mapPermission'>;

interface Message {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface PendingAsk {
  rpcId: number | string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const SHELL_NAME = 'Bash';
const PATCH_NAME = 'apply_patch';

export function createCodexDialect(input: CodexDialectInput): RpcDialect {
  let nextId = 1;
  const waiting = new Map<number, (msg: Message) => RpcStep>();
  let failed: string | null = null;
  let threadId: string | null = null;
  let ready = false;
  /** Ход в работе: uuid отправки, id хода из ответа `turn/start`, текст последнего ответа. */
  let turn: { uuid: string; cmdId: string; started: boolean; text: string } | null = null;
  const byCmd = new Map<string, number>();
  const asks = new Map<string, PendingAsk>();
  const fileChanges = new Map<string, unknown[]>();
  const usages: TurnUsage[] = [];
  let usageSeq = 0;

  const step = (events: AdapterEvent[] = [], out: RpcOut[] = []): RpcStep => ({ events, out });
  const line = (msg: Record<string, unknown>): string => JSON.stringify(msg);
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
    return step([{ type: 'error', code: 'protocol', detail: `codex handshake: ${reason}` }]);
  };

  const startThread = (): RpcOut => {
    const method = input.resume ? 'thread/resume' : 'thread/start';
    return request(
      method,
      {
        cwd: input.cwd,
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
        developerInstructions: input.developerInstructions,
        // Нить не эфемерная: файл разговора в доме сеанса — то, что продолжит следующая сессия.
        // Замер базы продолжать некому — его нить эфемерная, на диск разговор не ложится.
        ...(input.resume ? { threadId: input.resume } : { ephemeral: input.ephemeral === true }),
        ...(input.model ? { model: input.model } : {}),
      },
      (msg) => {
        const thread = isRecord(msg.result?.thread) ? msg.result.thread : null;
        const id = str(thread?.id);
        if (msg.error || !id) return fail(`${method}: ${msg.error?.message ?? 'no thread id'}`);
        // Продолжение под другим id — это новая нить, а не наш разговор: рукопожатие сорвано.
        if (input.resume && id !== input.resume) {
          return fail(`thread/resume answered thread ${id}, asked ${input.resume}`);
        }
        threadId = id;
        ready = true;
        return step([
          {
            type: 'init',
            conversationId: id,
            model: str(msg.result?.model) || input.model || '',
            tools: [],
            mcp: [],
          },
        ]);
      },
    );
  };

  const trustHooks = (msg: Message): RpcStep => {
    if (msg.error) return fail(`hooks/list: ${msg.error.message ?? 'error'}`);
    const data = Array.isArray(msg.result?.data) ? (msg.result.data as unknown[]) : [];
    const hooks = data.flatMap((d) =>
      isRecord(d) && Array.isArray(d.hooks) ? (d.hooks as unknown[]) : [],
    );
    // Доверие — только своему хуку из дома сеанса: хук репозитория остаётся недоверенным и не
    // исполняется (слой человека выключен), чужая команда под нашим именем не пройдёт.
    const ours = hooks.filter(
      (h): h is Record<string, unknown> =>
        isRecord(h) &&
        h.eventName === 'preToolUse' &&
        h.source === 'user' &&
        h.command === input.hookCommand &&
        typeof h.key === 'string' &&
        typeof h.currentHash === 'string',
    );
    if (ours.length !== 1) {
      return fail(`core hook listed ${ours.length} times by codex (expected exactly once)`);
    }
    const hook = ours[0] as Record<string, unknown>;
    return step(
      [],
      [
        request(
          'config/batchWrite',
          {
            edits: [
              {
                keyPath: 'hooks.state',
                value: { [hook.key as string]: { trusted_hash: hook.currentHash } },
                mergeStrategy: 'upsert',
              },
            ],
            reloadUserConfig: true,
          },
          (written) =>
            written.error
              ? fail(`config/batchWrite: ${written.error.message ?? 'error'}`)
              : step([], [startThread()]),
        ),
      ],
    );
  };

  const toolCall = (
    item: Record<string, unknown>,
  ): { name: string; input: Record<string, unknown> } | null => {
    if (item.type === 'commandExecution') {
      return { name: SHELL_NAME, input: { command: unwrapCodexShell(str(item.command)).inner } };
    }
    if (item.type === 'fileChange') {
      return {
        name: PATCH_NAME,
        input: { changes: Array.isArray(item.changes) ? item.changes : [] },
      };
    }
    if (item.type === 'mcpToolCall') {
      return {
        name: `mcp__${str(item.server)}__${str(item.tool)}`,
        input: isRecord(item.arguments) ? item.arguments : {},
      };
    }
    return null;
  };

  const onItem = (method: string, item: Record<string, unknown>): AdapterEvent[] => {
    const id = str(item.id);
    if (method === 'item/started') {
      if (item.type === 'userMessage') {
        if (!turn || turn.started) return [];
        if (item.clientId !== turn.uuid) {
          return [
            {
              type: 'error',
              code: 'protocol',
              detail: `codex echoed user message ${String(item.clientId)} for send ${turn.uuid}`,
            },
          ];
        }
        turn.started = true;
        return [{ type: 'turn.started', attribution: turn.uuid, origin: 'echo' }];
      }
      if (item.type === 'fileChange') fileChanges.set(id, (item.changes as unknown[]) ?? []);
      const call = toolCall(item);
      if (!call || !id) return [];
      return [
        {
          type: 'tool.requested',
          toolUseId: id,
          name: call.name,
          input: call.input,
          cliInitiated: false,
          parentToolUseId: null,
        },
      ];
    }
    // item/completed
    if (item.type === 'agentMessage') {
      if (turn) turn.text = str(item.text);
      return [];
    }
    if (!toolCall(item) || !id) return [];
    fileChanges.delete(id);
    const status = str(item.status);
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
    const output = str(item.aggregatedOutput);
    return [
      {
        type: 'tool.result',
        toolUseId: id,
        isError: status !== 'completed' || (exitCode !== null && exitCode !== 0),
        cliInitiated: false,
        ...(item.type === 'commandExecution'
          ? {
              outcome: {
                exitCode,
                errorText: null,
                bytes: output ? Buffer.byteLength(output) : null,
              },
            }
          : {}),
      },
    ];
  };

  const endTurn = (status: string, error: string | null): AdapterEvent[] => {
    const current = turn;
    turn = null;
    if (!current) return [];
    const events: AdapterEvent[] = [];
    if (!current.started) {
      events.push({ type: 'turn.started', attribution: current.uuid, origin: 'echo' });
    }
    events.push({
      type: 'turn.ended',
      attribution: current.uuid,
      origin: 'echo',
      isError: status !== 'completed',
      numTurns: 1,
      text: error ?? current.text,
    });
    byCmd.delete(current.cmdId);
    return events;
  };

  const onRequest = (msg: Message): RpcStep => {
    const rpcId = msg.id as number | string;
    const params = msg.params ?? {};
    const reply = (result: Record<string, unknown>): RpcOut => ({
      key: `reply:${String(rpcId)}`,
      line: line({ id: rpcId, result }),
    });
    let raw: { tool_name: string; input: Record<string, unknown>; tool_use_id: string } | null =
      null;
    const itemId = str(params.itemId);
    if (msg.method === 'item/commandExecution/requestApproval') {
      raw = {
        tool_name: SHELL_NAME,
        input: { command: unwrapCodexShell(str(params.command)).inner },
        tool_use_id: itemId,
      };
    } else if (msg.method === 'item/fileChange/requestApproval') {
      raw = {
        tool_name: PATCH_NAME,
        input: { changes: fileChanges.get(itemId) ?? [] },
        tool_use_id: itemId,
      };
    }
    if (!raw) {
      // Вопрос, на который ядро ответа не знает (права сети, ввод человека, elicitation MCP), —
      // отказ ошибкой, а не молчание: без ответа Codex ждёт посреди хода.
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
    if (input.permit === 'refuse' || !itemId) {
      const ask = input.mapPermission({ tool: raw.tool_name, input: raw.input });
      return step(
        [{ type: 'ask', ask, denied: true, ...(itemId ? { toolUseId: itemId } : {}) }],
        [reply({ decision: 'decline' })],
      );
    }
    const requestId = `codex:${String(rpcId)}`;
    asks.set(requestId, { rpcId });
    return step([{ type: 'permit.request', requestId, raw }]);
  };

  const onNotification = (msg: Message): RpcStep => {
    const params = msg.params ?? {};
    switch (msg.method) {
      case 'item/started':
      case 'item/completed':
        // Вне хода — не наш вызов: продолженная нить не повторяет прошлые вызовы как новые.
        return turn && isRecord(params.item) ? step(onItem(msg.method, params.item)) : step();
      case 'item/agentMessage/delta': {
        const delta = str(params.delta);
        return delta ? step([{ type: 'text.delta', text: delta }]) : step();
      }
      case 'thread/tokenUsage/updated': {
        const usage = isRecord(params.tokenUsage) ? params.tokenUsage : {};
        const last = isRecord(usage.last) ? usage.last : {};
        const cached = num(last.cachedInputTokens);
        usageSeq += 1;
        const entry: TurnUsage = {
          messageId: `${str(params.turnId)}:${usageSeq}`,
          // OpenAI считает кэш внутри входа; ядро — отдельно (как Anthropic).
          input: Math.max(0, num(last.inputTokens) - cached),
          cacheRead: cached,
          cacheWrite: num(last.cacheWriteInputTokens),
          output: num(last.outputTokens),
          ...(input.model ? { model: input.model } : {}),
          ...(typeof usage.modelContextWindow === 'number'
            ? { contextWindow: usage.modelContextWindow }
            : {}),
        };
        usages.push(entry);
        return step([{ type: 'usage', ...entry }]);
      }
      case 'hook/completed': {
        const run = isRecord(params.run) ? params.run : {};
        // Хук ядра упал — Codex пропускает вызов (fail-open, проба 02.11): сбой назван.
        if (run.status === 'failed') {
          const entries = Array.isArray(run.entries) ? (run.entries as unknown[]) : [];
          const why = entries.map((e) => (isRecord(e) ? str(e.text) : '')).filter(Boolean);
          return step([
            {
              type: 'error',
              code: 'protocol',
              detail: `codex ran the call after the core hook failed: ${why.join('; ') || 'no detail'}`,
            },
          ]);
        }
        return step();
      }
      case 'error': {
        const error = isRecord(params.error) ? params.error : {};
        if (params.willRetry === true) return step();
        return step([{ type: 'error', code: 'model-error', detail: str(error.message) }]);
      }
      case 'turn/completed': {
        const done = isRecord(params.turn) ? params.turn : {};
        const error = isRecord(done.error) ? str(done.error.message) : '';
        return step(endTurn(str(done.status), error || null));
      }
      default:
        return step();
    }
  };

  return {
    start: () => [
      request(
        'initialize',
        {
          clientInfo: { name: 'agentdeck-core', version: '1' },
          capabilities: { experimentalApi: true },
        },
        (msg) =>
          msg.error
            ? fail(`initialize: ${msg.error.message ?? 'error'}`)
            : step(
                [],
                [
                  { key: 'rpc:initialized', line: line({ method: 'initialized', params: {} }) },
                  request('hooks/list', { cwds: [input.cwd] }, trustHooks),
                ],
              ),
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
            detail: `codex stdout is not JSON: ${text.slice(0, 200)}`,
          },
        ]);
      }
      if (!isRecord(msg)) return step();
      if (msg.method && msg.id !== undefined) return onRequest(msg);
      if (msg.method) return onNotification(msg);
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
      turn = { uuid, cmdId, started: false, text: '' };
      const out = request(
        'turn/start',
        {
          threadId,
          clientUserMessageId: uuid,
          input: [{ type: 'text', text, text_elements: [] }],
          ...(input.effort ? { effort: input.effort } : {}),
        },
        (msg) =>
          msg.error
            ? step(endTurn('failed', `turn/start: ${msg.error.message ?? 'error'}`))
            : step(),
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
      return {
        key: `permit:${requestId}`,
        line: line({ id: ask.rpcId, result: { decision: codexDecision(reply) } }),
      };
    },

    get conversationId() {
      return threadId;
    },

    usage: () => [...usages],
  };
}
