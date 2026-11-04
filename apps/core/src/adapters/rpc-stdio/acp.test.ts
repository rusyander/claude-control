import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { mapGoosePermission, gooseToolName } from '../goose/permission.ts';
import { acpDecision, createAcpDialect, type AcpDialectInput } from './acp.ts';
import type { RpcDialect, RpcOut } from './rpc.types.ts';

/** Диалект ACP на строках формы живых проб goose 1.54 / opencode 1.18 (02.11). */

function dialect(over: Partial<AcpDialectInput> = {}): RpcDialect {
  return createAcpDialect({
    cli: 'goose',
    cwd: 'C:\\w',
    permit: 'core',
    mapPermission: mapGoosePermission,
    toolName: gooseToolName,
    model: 'stub-model',
    ...over,
  });
}

const parse = (out: RpcOut): Record<string, unknown> =>
  JSON.parse(out.line) as Record<string, unknown>;

function feeder(d: RpcDialect) {
  const out: RpcOut[] = [];
  const events: AdapterEvent[] = [];
  return {
    out,
    events,
    feed(msg: Record<string, unknown>) {
      const step = d.push(JSON.stringify({ jsonrpc: '2.0', ...msg }));
      out.push(...step.out);
      events.push(...step.events);
    },
  };
}

function handshake(d: RpcDialect, session: Record<string, unknown> = {}) {
  const f = feeder(d);
  f.out.push(...d.start());
  f.feed({ id: 1, result: { protocolVersion: 1, agentCapabilities: {} } });
  f.feed({ id: 2, result: { sessionId: 'ses-1', ...session } });
  return f;
}

const update = (u: Record<string, unknown>, sessionId = 'ses-1') => ({
  method: 'session/update',
  params: { sessionId, update: u },
});

const shellCall = (id: string, command: string) => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: `shell · ${command}`,
  rawInput: { command },
  _meta: { goose: { toolCall: { toolName: 'shell', extensionName: 'developer' } } },
});

describe('acp dialect — handshake', () => {
  it('initialize (protocol 1, no fs/terminal) → session/new in the cwd without mcp → init', () => {
    const d = dialect();
    const f = handshake(d);
    expect(f.out.map((o) => parse(o).method)).toEqual(['initialize', 'session/new']);
    expect(parse(f.out[0]!).params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(parse(f.out[1]!).params).toEqual({ cwd: 'C:\\w', mcpServers: [] });
    expect(f.events).toEqual([
      { type: 'init', conversationId: 'ses-1', model: 'stub-model', tools: [], mcp: [] },
    ]);
    expect(d.ready).toBe(true);
    expect(d.conversationId).toBe('ses-1');
  });

  it('a wrong protocol, an error or a refused session check fails closed', () => {
    const wrong = dialect();
    const f = feeder(wrong);
    wrong.start();
    f.feed({ id: 1, result: { protocolVersion: 2 } });
    expect(wrong.failed).toMatch(/protocol 2, expected 1/);
    expect(wrong.ready).toBe(false);
    expect(f.events[0]).toMatchObject({ type: 'error', code: 'protocol' });

    const err = dialect();
    err.start();
    err.push(JSON.stringify({ id: 1, error: { message: 'boom' } }));
    expect(err.failed).toMatch(/initialize: boom/);

    const checked = dialect({ checkSession: (r) => (r.ok ? null : 'mode auto') });
    const g = handshake(checked);
    expect(checked.failed).toMatch(/session\/new: mode auto/);
    expect(checked.ready).toBe(false);
    expect(g.events.some((e) => e.type === 'init')).toBe(false);
  });

  it('non-JSON stdout is a protocol error event', () => {
    const d = dialect();
    expect(d.push('not json').events[0]).toMatchObject({ type: 'error', code: 'protocol' });
  });
});

describe('acp dialect — session/load (resume)', () => {
  const loadCaps = { protocolVersion: 1, agentCapabilities: { loadSession: true } };

  it('step MCP servers ride session/new and session/load as given (s10 p6)', () => {
    const mcpServers = [
      { name: 'panel', command: 'node', args: ['b.mjs'], env: [{ name: 'T', value: 'x' }] },
    ];
    const fresh = handshake(dialect({ mcpServers }));
    expect(parse(fresh.out[1]!).params).toEqual({ cwd: 'C:\\w', mcpServers });
    const d = dialect({ load: 'ses-0', mcpServers });
    const f = feeder(d);
    f.out.push(...d.start());
    f.feed({ id: 1, result: loadCaps });
    expect(parse(f.out[1]!).params).toEqual({ sessionId: 'ses-0', cwd: 'C:\\w', mcpServers });
  });

  it('load: session/load of that id instead of session/new; the replayed history is not a turn', () => {
    const d = dialect({ load: '20261102_1' });
    const f = feeder(d);
    f.out.push(...d.start());
    f.feed({ id: 1, result: loadCaps });
    expect(f.out.map((o) => parse(o).method)).toEqual(['initialize', 'session/load']);
    expect(parse(f.out[1]!).params).toEqual({
      sessionId: '20261102_1',
      cwd: 'C:\\w',
      mcpServers: [],
    });
    // Goose проигрывает разговор уведомлениями ДО ответа: прошлый вызов и ответ — не события.
    f.feed(
      update(
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' } },
        '20261102_1',
      ),
    );
    f.feed(update(shellCall('old-call', 'git status'), '20261102_1'));
    f.feed(
      update(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'R' } },
        '20261102_1',
      ),
    );
    expect(f.events).toEqual([]);
    f.feed({ id: 2, result: { modes: { currentModeId: 'approve' } } });
    expect(f.events).toEqual([
      { type: 'init', conversationId: '20261102_1', model: 'stub-model', tools: [], mcp: [] },
    ]);
    expect(d.ready).toBe(true);
    expect(d.conversationId).toBe('20261102_1');
    // После загрузки ход идёт в тот же разговор.
    expect(JSON.parse(d.turn('next', 'c1', 'u1').line).params).toMatchObject({
      sessionId: '20261102_1',
    });
  });

  it('an agent without loadSession, a load error or a failed load check fails the handshake', () => {
    const none = dialect({ load: 's' });
    none.start();
    none.push(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, agentCapabilities: {} },
      }),
    );
    expect(none.failed).toMatch(/does not declare loadSession/);
    const broken = dialect({ load: 's' });
    broken.start();
    broken.push(JSON.stringify({ jsonrpc: '2.0', id: 1, result: loadCaps }));
    broken.push(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { message: 'Session not found' } }));
    expect(broken.failed).toMatch(/session\/load: Session not found/);
    const checked = dialect({ load: 's', checkSession: () => 'wrong mode' });
    checked.start();
    checked.push(JSON.stringify({ jsonrpc: '2.0', id: 1, result: loadCaps }));
    checked.push(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }));
    expect(checked.failed).toMatch(/session\/load: wrong mode/);
    expect(checked.ready).toBe(false);
  });
});

describe('acp dialect — a turn', () => {
  it('prompt → deltas, a tool call with its outcome, usage and the end text; attribution is ours', () => {
    const d = dialect();
    const f = handshake(d);
    const sent = d.turn('do it', 'cmd-1', 'uuid-A');
    expect(sent.key).toBe('cmd-1');
    expect(JSON.parse(sent.line)).toMatchObject({
      id: 3,
      method: 'session/prompt',
      params: { sessionId: 'ses-1', prompt: [{ type: 'text', text: 'do it' }] },
    });
    expect(d.ready).toBe(false);
    f.events.length = 0;
    f.feed(update(shellCall('c1', 'git status')));
    f.feed(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        rawOutput: { exit_code: 0 },
      }),
    );
    // Удержанный хуком вызов — `failed` с текстом отказа.
    f.feed(update(shellCall('c2', 'git push')));
    f.feed(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c2',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Denied by the platform' } }],
      }),
    );
    f.feed(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DO' } }));
    f.feed(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NE' } }));
    // Чужой сеанс — молча мимо.
    f.feed(
      update(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'X' } },
        'other',
      ),
    );
    f.feed({
      id: 3,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 10, cachedReadTokens: 4, cachedWriteTokens: 1, outputTokens: 2 },
      },
    });
    expect(f.events).toEqual([
      { type: 'turn.started', attribution: 'uuid-A', origin: 'echo' },
      {
        type: 'tool.requested',
        toolUseId: 'c1',
        name: 'shell',
        input: { command: 'git status' },
        cliInitiated: false,
        parentToolUseId: null,
      },
      {
        type: 'tool.result',
        toolUseId: 'c1',
        isError: false,
        cliInitiated: false,
        outcome: { exitCode: 0, errorText: null, bytes: null },
      },
      {
        type: 'tool.requested',
        toolUseId: 'c2',
        name: 'shell',
        input: { command: 'git push' },
        cliInitiated: false,
        parentToolUseId: null,
      },
      {
        type: 'tool.result',
        toolUseId: 'c2',
        isError: true,
        cliInitiated: false,
        outcome: { exitCode: null, errorText: 'Denied by the platform', bytes: null },
      },
      { type: 'text.delta', text: 'DO' },
      { type: 'text.delta', text: 'NE' },
      {
        type: 'usage',
        messageId: 'uuid-A:1',
        input: 6,
        cacheRead: 4,
        cacheWrite: 1,
        output: 2,
        model: 'stub-model',
      },
      {
        type: 'turn.ended',
        attribution: 'uuid-A',
        origin: 'echo',
        isError: false,
        numTurns: 1,
        text: 'DONE',
      },
    ]);
    expect(d.usage()).toHaveLength(1);
    expect(d.ready).toBe(true);
  });

  it('opencode shape: input arrives later, a non-zero exit is an error; a stop is a failed turn', () => {
    const d = dialect({ cli: 'opencode', toolName: (c) => String(c.title) });
    const f = handshake(d);
    d.turn('x', 'cmd-1', 'uuid-B');
    f.events.length = 0;
    f.feed(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'o1',
        title: 'bash',
        status: 'pending',
        rawInput: {},
      }),
    );
    expect(f.events.filter((e) => e.type === 'tool.requested')).toEqual([]);
    f.feed(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'o1',
        status: 'in_progress',
        title: 'git status',
        rawInput: { command: 'git status', cwd: 'C:\\w' },
      }),
    );
    f.feed(
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'o1',
        status: 'completed',
        rawOutput: { metadata: { exit: 1 } },
      }),
    );
    f.feed({ id: 3, result: { stopReason: 'cancelled' } });
    expect(f.events.find((e) => e.type === 'tool.requested')).toMatchObject({
      name: 'bash',
      input: { command: 'git status', cwd: 'C:\\w' },
    });
    expect(f.events.find((e) => e.type === 'tool.result')).toMatchObject({
      isError: true,
      outcome: { exitCode: 1 },
    });
    expect(f.events.at(-1)).toMatchObject({
      type: 'turn.ended',
      isError: true,
      text: 'stopped: cancelled',
    });
  });

  it('a prompt error ends the turn at once; forget drops the wait', () => {
    const d = dialect();
    const f = handshake(d);
    d.turn('x', 'cmd-1', 'uuid-C');
    f.events.length = 0;
    f.feed({ id: 3, error: { message: 'model down' } });
    expect(f.events).toEqual([
      { type: 'turn.started', attribution: 'uuid-C', origin: 'echo' },
      {
        type: 'turn.ended',
        attribution: 'uuid-C',
        origin: 'echo',
        isError: true,
        numTurns: 1,
        text: 'session/prompt: model down',
      },
    ]);
    d.turn('y', 'cmd-2', 'uuid-D');
    d.forget('cmd-2');
    expect(d.ready).toBe(true);
    expect(d.push(JSON.stringify({ id: 4, result: { stopReason: 'end_turn' } })).events).toEqual(
      [],
    );
  });

  it('retract (send never recorded) hands the request id back; forget (send recorded) keeps it spent', () => {
    const d = dialect();
    const f = handshake(d);
    const lost = d.turn('lost', 'cmd-0', 'uuid-0');
    d.retract('cmd-0');
    expect(d.ready).toBe(true);
    const next = d.turn('x', 'cmd-1', 'uuid-C');
    // Тот же id, что у несостоявшегося хода: повтор stdout.log выдаст его же.
    expect(JSON.parse(next.line).id).toBe(JSON.parse(lost.line).id);
    f.events.length = 0;
    f.feed({ id: 3, result: { stopReason: 'end_turn' } });
    expect(f.events.at(-1)).toMatchObject({
      type: 'turn.ended',
      attribution: 'uuid-C',
      isError: false,
    });
    d.turn('y', 'cmd-2', 'uuid-D');
    d.forget('cmd-2');
    expect(JSON.parse(d.turn('z', 'cmd-3', 'uuid-E').line).id).toBe(5);
  });
});

describe('acp dialect — permission asks', () => {
  const ask = (rpcId: number, id: string, command: string) => ({
    id: rpcId,
    method: 'session/request_permission',
    params: {
      sessionId: 'ses-1',
      toolCall: { toolCallId: id, rawInput: { command } },
      options: [
        { optionId: 'aa', kind: 'allow_always', name: 'Always' },
        { optionId: 'a1', kind: 'allow_once', name: 'Once' },
        { optionId: 'r1', kind: 'reject_once', name: 'No' },
      ],
    },
  });

  it('core answers: permit.request with the known call; accept → allow_once, anything else → reject_once', () => {
    const d = dialect();
    const f = handshake(d);
    d.turn('x', 'cmd-1', 'uuid-A');
    f.feed(update(shellCall('c1', 'git status')));
    f.events.length = 0;
    f.feed(ask(7, 'c1', 'git status'));
    expect(f.events).toEqual([
      {
        type: 'permit.request',
        requestId: 'goose:7',
        raw: { tool_name: 'shell', input: { command: 'git status' }, tool_use_id: 'c1' },
      },
    ]);
    expect(f.out.filter((o) => o.key.startsWith('reply:'))).toEqual([]);
    const yes = d.answer('goose:7', { decision: 'accept' });
    expect(JSON.parse(yes!.line)).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { outcome: { outcome: 'selected', optionId: 'a1' } },
    });
    // Ответ один: повтор — нет вопроса.
    expect(d.answer('goose:7', { decision: 'accept' })).toBeUndefined();
    f.feed(ask(8, 'c2', 'git push'));
    const no = d.answer('goose:8', { decision: 'acceptForSession' });
    expect(JSON.parse(no!.line).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'r1' },
    });
  });

  it('no answerer: declined in place (reject_once, else cancelled) and reported as a denied ask', () => {
    const d = dialect({ permit: 'refuse' });
    const f = handshake(d);
    d.turn('x', 'cmd-1', 'uuid-A');
    f.feed(update(shellCall('c3', 'git push origin main')));
    f.events.length = 0;
    f.feed(ask(9, 'c3', 'git push origin main'));
    expect(f.events.at(-1)).toMatchObject({
      type: 'ask',
      denied: true,
      toolUseId: 'c3',
      ask: { action: 'exec', target: 'git' },
    });
    expect(JSON.parse(f.out.at(-1)!.line)).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { outcome: { outcome: 'selected', optionId: 'r1' } },
    });
    f.feed({
      id: 10,
      method: 'session/request_permission',
      params: { toolCall: { toolCallId: 'c4' }, options: [{ optionId: 'a1', kind: 'allow_once' }] },
    });
    expect(JSON.parse(f.out.at(-1)!.line).result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('a request the core cannot answer gets an error reply, never silence', () => {
    const d = dialect();
    const f = handshake(d);
    f.feed({ id: 11, method: 'fs/read_text_file', params: { path: 'x' } });
    expect(JSON.parse(f.out.at(-1)!.line)).toMatchObject({
      id: 11,
      error: { code: -32601 },
    });
  });

  it('acpDecision: only a literal accept allows', () => {
    expect(acpDecision({ decision: 'accept' })).toBe('accept');
    expect(acpDecision({ decision: 'acceptForSession' })).toBe('decline');
    expect(acpDecision(null)).toBe('decline');
    expect(acpDecision('accept')).toBe('decline');
  });
});
