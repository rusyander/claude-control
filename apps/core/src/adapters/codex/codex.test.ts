import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, SessionSpec } from '../adapter.types.ts';
import type { RpcDialect, RpcOut } from '../rpc-stdio/rpc.types.ts';
import { createCodexDialect, type CodexDialectInput } from './app-server.ts';
import {
  bindCodexEndpoint,
  CODEX_CHANNELS,
  CODEX_FILES,
  codexHookCommand,
  codexLayer,
  codexRules,
  planCodex,
  refuseCodex,
} from './codex.ts';
import { CODEX_PERMIT_CODEC, mapCodexPermission, unwrapCodexShell } from './permission.ts';

const HOOK = 'C:\\n\\node.exe C:\\s\\codex-home\\agentdeck-hook.mjs C:\\n\\node.exe run.ts hook';
const PWSH = '"C:\\\\Users\\\\u\\\\pwsh.exe" -Command';

function dialect(over: Partial<CodexDialectInput> = {}): RpcDialect {
  return createCodexDialect({
    cwd: 'C:\\w',
    hookCommand: HOOK,
    approvalPolicy: 'untrusted',
    sandbox: 'read-only',
    developerInstructions: 'BRIEF',
    model: 'stub-model',
    permit: 'core',
    mapPermission: mapCodexPermission,
    ...over,
  });
}

const parse = (out: RpcOut): Record<string, unknown> =>
  JSON.parse(out.line) as Record<string, unknown>;

const hooksList = (hooks: Record<string, unknown>[]) =>
  JSON.stringify({ id: 2, result: { data: [{ cwd: 'C:\\w', hooks }] } });

const ourHook = {
  key: 'C:\\s\\codex-home\\hooks.json:pre_tool_use:0:0',
  eventName: 'preToolUse',
  source: 'user',
  command: HOOK,
  currentHash: 'sha256:abc',
};

/** Рукопожатие до готовности; строки, которые диалект отдал, — по порядку. */
function handshake(d: RpcDialect): { out: RpcOut[]; events: AdapterEvent[] } {
  const out = [...d.start()];
  const events: AdapterEvent[] = [];
  const feed = (line: string) => {
    const step = d.push(line);
    out.push(...step.out);
    events.push(...step.events);
  };
  feed(JSON.stringify({ id: 1, result: { userAgent: 'codex' } }));
  feed(hooksList([ourHook]));
  feed(JSON.stringify({ id: 3, result: { status: 'ok' } }));
  feed(JSON.stringify({ id: 4, result: { thread: { id: 'thr-1' }, model: 'stub-model' } }));
  return { out, events };
}

const item = (method: string, it: Record<string, unknown>) =>
  JSON.stringify({ method, params: { item: it, threadId: 'thr-1', turnId: 'turn-1' } });

describe('codex app-server dialect — handshake', () => {
  it('initialize → initialized → hooks/list → trust of the core hook only → thread/start → init', () => {
    const d = dialect();
    expect(d.ready).toBe(false);
    const { out, events } = handshake(d);
    expect(out.map((o) => (parse(o).method as string) ?? '')).toEqual([
      'initialize',
      'initialized',
      'hooks/list',
      'config/batchWrite',
      'thread/start',
    ]);
    const trust = parse(out[3]!).params as { edits: { keyPath: string; value: unknown }[] };
    expect(trust.edits).toEqual([
      {
        keyPath: 'hooks.state',
        value: { [ourHook.key]: { trusted_hash: 'sha256:abc' } },
        mergeStrategy: 'upsert',
      },
    ]);
    expect(parse(out[4]!).params).toMatchObject({
      cwd: 'C:\\w',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: 'BRIEF',
      ephemeral: false,
      model: 'stub-model',
    });
    expect(events).toEqual([
      { type: 'init', conversationId: 'thr-1', model: 'stub-model', tools: [], mcp: [] },
    ]);
    expect(d.ready).toBe(true);
    expect(d.conversationId).toBe('thr-1');
    expect(d.failed).toBeNull();
  });

  it('no core hook listed → handshake fails closed, sends refused; a repo hook is never trusted', () => {
    const d = dialect();
    d.start();
    d.push(JSON.stringify({ id: 1, result: {} }));
    const step = d.push(
      hooksList([
        { ...ourHook, source: 'project' },
        { ...ourHook, command: 'evil' },
      ]),
    );
    expect(step.out).toEqual([]);
    expect(step.events[0]).toMatchObject({ type: 'error', code: 'protocol' });
    expect(d.failed).toMatch(/core hook listed 0 times/);
    expect(d.ready).toBe(false);
  });

  it('an initialize error fails the handshake', () => {
    const d = dialect();
    d.start();
    d.push(JSON.stringify({ id: 1, error: { message: 'boom' } }));
    expect(d.failed).toMatch(/initialize: boom/);
  });
});

describe('codex app-server dialect — a turn', () => {
  it('echo attribution, deltas, a shell call with its outcome, usage and the end text', () => {
    const d = dialect();
    handshake(d);
    const sent = d.turn('hello', 'cmd-1', 'uuid-1');
    expect(sent.key).toBe('cmd-1');
    expect(JSON.parse(sent.line)).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: 'thr-1',
        clientUserMessageId: 'uuid-1',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      },
    });
    expect(d.ready).toBe(false);
    const events = [
      item('item/started', { type: 'userMessage', id: 'u', clientId: 'uuid-1' }),
      item('item/started', {
        type: 'commandExecution',
        id: 'call_1',
        command: `${PWSH} 'echo it''s; git push'`,
        status: 'inProgress',
      }),
      item('item/completed', {
        type: 'commandExecution',
        id: 'call_1',
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: 'hi\r\n',
      }),
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta: 'all ', itemId: 'm' },
      }),
      item('item/completed', { type: 'agentMessage', id: 'm', text: 'all done' }),
      JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          turnId: 'turn-1',
          tokenUsage: {
            last: {
              inputTokens: 10,
              cachedInputTokens: 4,
              cacheWriteInputTokens: 1,
              outputTokens: 2,
            },
            modelContextWindow: 1000,
          },
        },
      }),
      JSON.stringify({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed', error: null } },
      }),
    ].flatMap((l) => d.push(l).events);
    expect(events).toEqual([
      { type: 'turn.started', attribution: 'uuid-1', origin: 'echo' },
      {
        type: 'tool.requested',
        toolUseId: 'call_1',
        name: 'Bash',
        input: { command: "echo it's; git push" },
        cliInitiated: false,
        parentToolUseId: null,
      },
      {
        type: 'tool.result',
        toolUseId: 'call_1',
        isError: false,
        cliInitiated: false,
        outcome: { exitCode: 0, errorText: null, bytes: 4 },
      },
      { type: 'text.delta', text: 'all ' },
      {
        type: 'usage',
        messageId: 'turn-1:1',
        input: 6,
        cacheRead: 4,
        cacheWrite: 1,
        output: 2,
        model: 'stub-model',
        contextWindow: 1000,
      },
      {
        type: 'turn.ended',
        attribution: 'uuid-1',
        origin: 'echo',
        isError: false,
        numTurns: 1,
        text: 'all done',
      },
    ]);
    expect(d.usage()).toHaveLength(1);
    expect(d.ready).toBe(true);
  });

  it('a foreign echo is a protocol error; a failed turn ends with its error text', () => {
    const d = dialect();
    handshake(d);
    d.turn('x', 'c', 'mine');
    const wrong = d.push(item('item/started', { type: 'userMessage', id: 'u', clientId: 'other' }));
    expect(wrong.events[0]).toMatchObject({ type: 'error', code: 'protocol' });
    const end = d.push(
      JSON.stringify({
        method: 'turn/completed',
        params: { turn: { status: 'failed', error: { message: '401 Unauthorized' } } },
      }),
    ).events;
    expect(end).toEqual([
      { type: 'turn.started', attribution: 'mine', origin: 'echo' },
      {
        type: 'turn.ended',
        attribution: 'mine',
        origin: 'echo',
        isError: true,
        numTurns: 1,
        text: '401 Unauthorized',
      },
    ]);
  });

  it('turn/start answered with an error ends the turn at once; forget drops the wait', () => {
    const d = dialect();
    handshake(d);
    d.turn('x', 'c1', 'u1');
    const ended = d.push(JSON.stringify({ id: 5, error: { message: 'busy' } })).events;
    expect(ended.at(-1)).toMatchObject({
      type: 'turn.ended',
      isError: true,
      text: 'turn/start: busy',
    });
    d.turn('y', 'c2', 'u2');
    d.forget('c2');
    expect(d.ready).toBe(true);
    expect(d.push(JSON.stringify({ id: 6, error: { message: 'late' } })).events).toEqual([]);
  });

  it('retract (send never recorded) hands the request id back; forget (send recorded) keeps it spent', () => {
    const d = dialect();
    handshake(d);
    const lost = d.turn('lost', 'c1', 'u1');
    d.retract('c1');
    expect(d.ready).toBe(true);
    const next = d.turn('x', 'c2', 'u2');
    // Тот же id, что у несостоявшегося хода: повтор stdout.log выдаст его же.
    expect(JSON.parse(next.line).id).toBe(JSON.parse(lost.line).id);
    expect(
      d.push(JSON.stringify({ id: 5, error: { message: 'busy' } })).events.at(-1),
    ).toMatchObject({ type: 'turn.ended', attribution: 'u2', isError: true });
    d.turn('y', 'c3', 'u3');
    d.forget('c3');
    expect(JSON.parse(d.turn('z', 'c4', 'u4').line).id).toBe(7);
  });

  it('a failed core hook run (codex is fail-open) is named; a blocked run is silent', () => {
    const d = dialect();
    handshake(d);
    const failed = d.push(
      JSON.stringify({
        method: 'hook/completed',
        params: {
          run: { status: 'failed', entries: [{ kind: 'error', text: 'hook exited with code 1' }] },
        },
      }),
    );
    expect(failed.events[0]).toMatchObject({ type: 'error', code: 'protocol' });
    expect((failed.events[0] as { detail: string }).detail).toMatch(/hook exited with code 1/);
    const blocked = d.push(
      JSON.stringify({ method: 'hook/completed', params: { run: { status: 'blocked' } } }),
    );
    expect(blocked.events).toEqual([]);
  });

  it('a model error that will not retry is a model-error event', () => {
    const d = dialect();
    handshake(d);
    expect(
      d.push(
        JSON.stringify({ method: 'error', params: { error: { message: 'x' }, willRetry: true } }),
      ).events,
    ).toEqual([]);
    expect(
      d.push(
        JSON.stringify({ method: 'error', params: { error: { message: 'x' }, willRetry: false } }),
      ).events,
    ).toEqual([{ type: 'error', code: 'model-error', detail: 'x' }]);
  });
});

describe('codex app-server dialect — permission asks', () => {
  const approval = (id: number, command: string) =>
    JSON.stringify({
      id,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'call_9', command, commandActions: [{ command: 'echo hi' }] },
    });

  it('core answers: the ask carries the UNWRAPPED whole command; the reply is accept/decline only', () => {
    const d = dialect();
    handshake(d);
    const step = d.push(approval(0, `${PWSH} 'echo hi; git push'`));
    expect(step.out).toEqual([]);
    expect(step.events).toEqual([
      {
        type: 'permit.request',
        requestId: 'codex:0',
        raw: { tool_name: 'Bash', input: { command: 'echo hi; git push' }, tool_use_id: 'call_9' },
      },
    ]);
    const read = CODEX_PERMIT_CODEC.read((step.events[0] as { raw: unknown }).raw);
    expect(read).toEqual({
      toolUseId: 'call_9',
      call: { tool: 'Bash', input: { command: 'echo hi; git push' } },
    });
    const yes = d.answer('codex:0', CODEX_PERMIT_CODEC.render({ allow: true, input: {} }));
    expect(JSON.parse(yes!.line)).toEqual({ id: 0, result: { decision: 'accept' } });
    expect(d.answer('codex:0', { decision: 'accept' })).toBeUndefined();
    d.push(approval(1, 'ls'));
    expect(JSON.parse(d.answer('codex:1', { decision: 'acceptForSession' })!.line)).toEqual({
      id: 1,
      result: { decision: 'decline' },
    });
  });

  it('a file change ask names the changes from its item', () => {
    const d = dialect();
    handshake(d);
    // Вызовы бывают только внутри хода: вне хода диалект их не слушает (продолженная нить).
    d.turn('patch it', 'cmd-1', 'u-1');
    d.push(
      item('item/started', {
        type: 'fileChange',
        id: 'p1',
        changes: [{ path: 'C:\\w\\a.ts', kind: { type: 'update' } }],
      }),
    );
    const step = d.push(
      JSON.stringify({
        id: 7,
        method: 'item/fileChange/requestApproval',
        params: { itemId: 'p1' },
      }),
    );
    const raw = (step.events[0] as { raw: { tool_name: string; input: unknown } }).raw;
    expect(raw.tool_name).toBe('apply_patch');
    expect(
      mapCodexPermission({ tool: raw.tool_name, input: raw.input as Record<string, unknown> }),
    ).toMatchObject({
      action: 'edit',
      target: 'C:\\w\\a.ts',
    });
  });

  it('no answerer: the ask is declined in place and reported as a denied ask', () => {
    const d = dialect({ permit: 'refuse' });
    handshake(d);
    const step = d.push(approval(3, `${PWSH} 'git push'`));
    expect(JSON.parse(step.out[0]!.line)).toEqual({ id: 3, result: { decision: 'decline' } });
    expect(step.events[0]).toMatchObject({
      type: 'ask',
      denied: true,
      toolUseId: 'call_9',
      ask: { action: 'exec', argv: ['git', 'push'] },
    });
  });

  it('a request the core cannot answer gets an error reply, never silence', () => {
    const d = dialect();
    handshake(d);
    const step = d.push(
      JSON.stringify({ id: 8, method: 'item/tool/requestUserInput', params: {} }),
    );
    expect(JSON.parse(step.out[0]!.line)).toMatchObject({ id: 8, error: { code: -32601 } });
  });
});

describe('codex permission vocabulary', () => {
  it('unwraps pwsh and posix wrappers; an unknown quoting is inexact', () => {
    expect(unwrapCodexShell(`${PWSH} 'echo it''s'`)).toEqual({ inner: "echo it's", exact: true });
    expect(unwrapCodexShell("/bin/bash -lc 'git push origin'")).toEqual({
      inner: 'git push origin',
      exact: true,
    });
    expect(unwrapCodexShell('git push')).toEqual({ inner: 'git push', exact: true });
    expect(unwrapCodexShell('/bin/bash -lc "git push"').exact).toBe(false);
    // Не оболочка — не обёртка: строка как есть.
    expect(unwrapCodexShell("python -c 'x'")).toEqual({ inner: "python -c 'x'", exact: true });
  });

  it('a shell call maps to exec with argv of the inner command', () => {
    expect(
      mapCodexPermission({ tool: 'Bash', input: { command: `${PWSH} 'git push origin main'` } }),
    ).toMatchObject({
      action: 'exec',
      target: 'git',
      argv: ['git', 'push', 'origin', 'main'],
      argvExact: true,
      display: 'git push origin main',
    });
    expect(mapCodexPermission({ tool: 'Bash', input: { command: 'echo $HOME' } }).argvExact).toBe(
      false,
    );
  });

  it('apply_patch: one path is an edit, several are other; mcp and unknown tools', () => {
    const two = { changes: [{ path: 'a' }, { path: 'b' }] };
    expect(mapCodexPermission({ tool: 'apply_patch', input: two })).toMatchObject({
      action: 'other',
    });
    expect(mapCodexPermission({ tool: 'apply_patch', input: {} })).toMatchObject({
      action: 'other',
    });
    expect(mapCodexPermission({ tool: 'mcp__s__t', input: {} })).toMatchObject({
      action: 'mcp',
      target: 'mcp__s__t',
    });
    expect(mapCodexPermission({ tool: 'web_search', input: {} })).toMatchObject({
      action: 'other',
    });
  });
});

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: 's',
    dir: 'C:\\sess\\s1',
    cwd: 'C:\\w',
    brief: 'B',
    deny: {
      paths: [],
      commands: [
        ['git', 'push'],
        ['gh', 'pr', 'create'],
      ],
      mcpTools: [],
      tools: [],
    },
    platform: { coreHome: 'C:\\core', tokenFiles: [] },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    core: {
      taskId: 't',
      stepId: 'st',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'x',
    },
    coreHook: '"C:\\n\\node.exe" "--experimental-strip-types" "C:\\c\\run.ts" hook',
    endpoint: {
      channel: CODEX_CHANNELS[0]!,
      endpoint: {
        baseUrl: 'http://127.0.0.1:9/',
        dialect: 'openai-responses',
        model: 'm',
        key: 'k',
      },
    },
    ...over,
  } as SessionSpec;
}

describe('codex session files and refusals', () => {
  it('binds the endpoint into the session CODEX_HOME config only; other dialects refused', () => {
    const got = bindCodexEndpoint(CODEX_CHANNELS[0]!, spec().endpoint!.endpoint);
    if (!got.ok) throw new Error('bind refused');
    // Файл — внутри CODEX_HOME сеанса (его же ставит план), не в каталоге сеанса и не выше.
    expect(Object.keys(got.binding.files)).toEqual(['codex-home/config.toml']);
    const home = planCodex(spec(), null, codexLayer(spec())).env?.CODEX_HOME;
    expect(join(spec().dir, 'codex-home/config.toml')).toBe(join(home!, 'config.toml'));
    expect(got.binding.env).toEqual({ AGENTDECK_CODEX_KEY: 'k' });
    const config = got.binding.files[CODEX_FILES.config]!;
    expect(config).toContain('base_url = "http://127.0.0.1:9/v1"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('env_key = "AGENTDECK_CODEX_KEY"');
    expect(config).not.toContain('"k"');
    expect(
      bindCodexEndpoint(
        { ...CODEX_CHANNELS[0]!, dialect: 'openai-chat' },
        { ...spec().endpoint!.endpoint, dialect: 'openai-chat' },
      ),
    ).toEqual({ ok: false, code: 'no_channel' });
  });

  it('hook command: the core hook words unquoted + --json (deny as JSON, never by exit code)', () => {
    expect(codexHookCommand(spec())).toBe(
      'C:\\n\\node.exe --experimental-strip-types C:\\c\\run.ts hook --json',
    );
    expect(codexHookCommand(spec({ dir: '/s/1', coreHook: '"/s/1/core-hook"' }))).toBe(
      '/s/1/core-hook --json',
    );
    expect(codexHookCommand(spec({ coreHook: '"C:\\Program Files\\node.exe" x' }))).toBeNull();
  });

  it('refuses: no core hook, an unquotable hook, no endpoint (a resume is judged by its transcript)', () => {
    expect(refuseCodex(spec({ coreHook: undefined }))).toMatch(/^no core hook/);
    expect(refuseCodex(spec({ coreHook: '"a b" c' }))).toMatch(
      /whitespace or a shell metacharacter/,
    );
    expect(refuseCodex(spec({ endpoint: undefined }))).toMatch(/routed endpoint/);
    expect(refuseCodex(spec({ resume: { conversationId: 'x' } }))).toBeNull();
    expect(refuseCodex(spec())).toBeNull();
  });

  it('execpolicy rules forbid every deny command (P81 backstop); plan writes hooks and rules', () => {
    expect(codexRules(spec())).toBe(
      'prefix_rule(pattern=["git", "push"], decision="forbidden", justification="agentdeck: refused by the platform")\n' +
        'prefix_rule(pattern=["gh", "pr", "create"], decision="forbidden", justification="agentdeck: refused by the platform")\n',
    );
    const s = spec({
      mcpServers: {
        panel: { command: 'x', args: ['-y'], env: { K: 'v' } },
        'agentdeck-permit': { command: 'p', args: [] },
      },
      permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    });
    const plan = planCodex(s, null, codexLayer(s));
    expect(plan.args).toEqual(['app-server']);
    expect(plan.env.CODEX_HOME).toBe(join('C:\\sess\\s1', 'codex-home'));
    expect(Object.keys(plan.files).sort()).toEqual(
      [CODEX_FILES.config, CODEX_FILES.hooks, CODEX_FILES.rules].sort(),
    );
    // Серверы шага — таблицами config.toml дома сеанса; запись сервера права не переносится.
    expect(plan.files[CODEX_FILES.config]).toBe(
      '\n[mcp_servers."panel"]\ncommand = "x"\nargs = ["-y"]\nenv = { "K" = "v" }\n',
    );
    const hooks = JSON.parse(plan.files[CODEX_FILES.hooks]!) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    };
    expect(hooks.hooks.PreToolUse[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: codexHookCommand(s), timeout: 60 }],
    });
    expect(plan.layerLosses).toBeUndefined();
    // Привязка адреса и MCP — один файл: план дописывает таблицы к config.toml привязки.
    const bound = { env: {}, argv: [], files: { [CODEX_FILES.config]: 'model = "m"\n' } };
    expect(planCodex(s, bound, codexLayer(s)).files[CODEX_FILES.config]).toMatch(
      /^model = "m"\n\n\[mcp_servers\."panel"\]/,
    );
    // Без серверов шага план файла привязки не трогает.
    expect(planCodex(spec(), bound, codexLayer(spec())).files[CODEX_FILES.config]).toBeUndefined();
  });

  it('the human layer never loads: hooks on → off is a named loss', () => {
    expect(codexLayer(spec())).toMatchObject({
      asked: 'on',
      ran: 'off',
      repoLayer: false,
      losses: [expect.stringMatching(/no layer control/)],
    });
    expect(codexLayer(spec({ layer: { hooks: 'off', skills: 'on' } })).losses).toBeUndefined();
  });
});
