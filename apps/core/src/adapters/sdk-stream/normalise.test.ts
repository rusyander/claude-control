import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { mapClaudePermission } from '../claude/permission.ts';
import { fixturePath } from '../conformance/__fixtures__/replay.ts';
import { mapQwenPermission } from '../qwen/permission.ts';
import { SdkNormaliser, type SdkRule } from './normalise.ts';

/**
 * Разбор `stream-json` по ЗАПИСЯМ живых CLI (28.10: claude 2.1.310, qwen 0.24.3, модель —
 * stub-model) и по коротким строкам там, где запись случай не даёт (уведомление, хвост).
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const CLAUDE: SdkRule = {
  echo: true,
  mapPermission: mapClaudePermission,
  classifyError: (t) => (/No conversation found/.test(t) ? 'fresh-required' : null),
};
const QWEN: SdkRule = { echo: false, mapPermission: mapQwenPermission };

function play(
  cli: string,
  name: string,
  rule: SdkRule,
  ids: string[] = [A, B],
): { events: AdapterEvent[]; n: SdkNormaliser } {
  const n = new SdkNormaliser(rule);
  for (const id of ids) n.expect(id, id);
  const events: AdapterEvent[] = [];
  for (const line of readFileSync(fixturePath(cli, name), 'utf8').split('\n')) {
    if (line.trim()) events.push(...n.push(line));
  }
  return { events, n };
}

const shape = (events: AdapterEvent[]): string[] =>
  events
    .filter((e) => e.type !== 'text.delta' && e.type !== 'usage')
    .map((e) => {
      if (e.type === 'turn.started') return `started ${e.attribution.slice(0, 2)} ${e.origin}`;
      if (e.type === 'turn.ended') return `ended ${e.attribution.slice(0, 2)} ${e.text}`;
      if (e.type === 'turn.cli-initiated') return `cli ${e.cause} ${e.numTurns}`;
      if (e.type === 'tool.requested') return `tool ${e.name} cli=${e.cliInitiated}`;
      if (e.type === 'tool.result') return `result error=${e.isError}`;
      if (e.type === 'ask') return `ask ${e.ask.action} denied=${e.denied}`;
      if (e.type === 'error') return `error ${e.code}`;
      return e.type;
    });

const line = (value: Record<string, unknown>): string => JSON.stringify(value);

describe('sdk-stream normaliser — recorded streams', () => {
  it('echo rule (claude): each turn opens on our uuid, the replayed user line opens nothing twice', () => {
    const { events, n } = play('claude', 'basic', CLAUDE);
    expect(shape(events)).toEqual([
      'started 11 echo',
      'init',
      'ended 11 REPLY_0',
      'started 22 echo',
      'ended 22 REPLY_1',
    ]);
    expect(events.filter((e) => e.type === 'text.delta').length).toBeGreaterThan(0);
    // Вход — из начала сообщения, выход — из дельты: части сводятся по id сообщения; окно —
    // из `result.modelUsage.stub-model.contextWindow` записи.
    const stub = { input: 11, cacheRead: 5, cacheWrite: 0, cacheWrite1h: 0, output: 3 };
    // Строки главного контекста (`parent_tool_use_id: null`) несут родителя `null` (P149).
    const reported = { model: 'stub-model', contextWindow: 64_000, parentToolUseId: null };
    expect(n.usage()).toEqual([
      { messageId: 'msg_stub_1', ...stub, ...reported },
      { messageId: 'msg_stub_2', ...stub, ...reported },
    ]);
    // Первое сообщение издано без окна и ещё раз с ним (итог хода), второе — сразу с ним.
    const usage = events.flatMap((e) => (e.type === 'usage' ? [e] : []));
    expect(usage.map((u) => [u.messageId, u.contextWindow ?? null])).toEqual([
      ['msg_stub_1', null],
      ['msg_stub_1', 64_000],
      ['msg_stub_2', 64_000],
    ]);
    expect(n.conversationId).toBe('9b3cf7bf-2fde-4b51-8105-d5430440b8db');
    expect(n.busy).toBe(false);
    expect(n.waiting).toBe(0);
  });

  it('sequence rule (qwen): no echo, the next started turn takes the first waiting send', () => {
    const { events } = play('qwen', 'basic', QWEN);
    expect(shape(events)).toEqual([
      'started 11 sequence',
      'init',
      'ended 11 REPLY_0',
      'started 22 sequence',
      'ended 22 REPLY_2',
    ]);
    // Каждое сообщение отчитано ровно одним `usage`.
    const usage = events.filter((e) => e.type === 'usage');
    expect(new Set(usage.map((e) => (e.type === 'usage' ? e.messageId : ''))).size).toBe(
      usage.length,
    );
  });

  it('a background task wake after our turn is a cli-initiated turn, never the end of ours', () => {
    const { events } = play('claude', 'bg-permit-allow', CLAUDE);
    expect(shape(events)).toEqual([
      'started 11 echo',
      'init',
      'tool Bash cli=false',
      'result error=false',
      'ended 11 REPLY_1',
      'cli background-wake 1',
    ]);
  });

  it.each([
    ['claude', 'deny', CLAUDE, 'Read'],
    ['qwen', 'readdeny', QWEN, 'read_file'],
  ] as const)(
    '%s deny overlay: the refused read is a denied typed ask',
    (cli, name, rule, tool) => {
      const { events } = play(cli, name, rule);
      expect(shape(events)).toContain('result error=true');
      const ask = events.find((e) => e.type === 'ask');
      expect(ask).toMatchObject({ ask: { action: 'read', tool }, denied: true });
    },
  );

  it('a shell refusal carries the parsed argv of the command', () => {
    const { events } = play('claude', 'permit', CLAUDE);
    expect(events.find((e) => e.type === 'ask')).toMatchObject({
      ask: {
        action: 'exec',
        target: 'node',
        argv: ['node', '-e', 'process.stdout.write(1+String(2))'],
      },
      denied: true,
    });
  });

  it('a missing conversation is a session error classified by the adapter rule', () => {
    expect(shape(play('claude', 'missing', CLAUDE).events)).toEqual(['error fresh-required']);
    const plain = play('claude', 'missing', { ...CLAUDE, classifyError: undefined } as SdkRule);
    expect(plain.events).toMatchObject([
      { type: 'error', code: 'model-error', detail: expect.stringContaining('No conversation') },
    ]);
  });

  it('in-band permission questions queue for the session pump, once', () => {
    const { events, n } = play('qwen', 'permit-core-allow', QWEN);
    expect(shape(events)).toContain('ended 11 REPLY_1');
    const controls = n.takeControl();
    expect(controls).toHaveLength(1);
    expect(controls[0]).toMatchObject({
      subtype: 'can_use_tool',
      request: { tool_name: 'run_shell_command', tool_use_id: 'call_stub_1_0' },
    });
    expect(n.takeControl()).toEqual([]);
  });
});

describe('sdk-stream normaliser — cases no recording gives', () => {
  const init = line({ type: 'system', subtype: 'init', session_id: 'conv-1', model: 'm' });
  const result = (numTurns: number, extra: Record<string, unknown> = {}) =>
    line({ type: 'result', subtype: 'success', num_turns: numTurns, result: 'R', ...extra });

  it('a result with no turn of ours is a notification (num_turns 0) — tools in it are cli-initiated', () => {
    const n = new SdkNormaliser(CLAUDE);
    expect(n.push(init)).toMatchObject([
      { type: 'init', conversationId: 'conv-1', tools: [], mcp: [] },
    ]);
    expect(n.cliBusy).toBe(true);
    const tool = n.push(
      line({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Read' }, 'junk'] },
      }),
    );
    expect(tool).toEqual([
      {
        type: 'tool.requested',
        toolUseId: 't1',
        name: 'Read',
        input: {},
        cliInitiated: true,
        parentToolUseId: null,
      },
    ]);
    expect(n.push(result(0))).toEqual([
      { type: 'turn.cli-initiated', cause: 'notification', numTurns: 0 },
    ]);
    expect(n.busy).toBe(false);
  });

  it('a late tail of a closed turn is named, and our echo cuts a dangling cli turn short', () => {
    const n = new SdkNormaliser(CLAUDE);
    n.expect(A, A);
    n.push(line({ type: 'command_lifecycle', state: 'started', command_uuid: A }));
    n.push(result(1));
    // Строка уже закрытого хода: хвост, не новый ход и не наш.
    expect(
      n.push(
        line({
          type: 'stream_event',
          user_message_uuid: A,
          event: { type: 'message_start', message: {} },
        }),
      ),
    ).toEqual([{ type: 'turn.cli-initiated', cause: 'late-tail', numTurns: 0 }]);
    expect(n.busy).toBe(false);
    n.push(result(0));
    // Ход CLI без `result`, затем эхо нашей отправки.
    n.push(line({ type: 'assistant', message: { content: [] } }));
    expect(n.cliBusy).toBe(true);
    n.expect(B, B);
    expect(n.push(line({ type: 'user', isReplay: true, uuid: B }))).toEqual([
      { type: 'turn.cli-initiated', cause: 'late-tail', numTurns: 0 },
      { type: 'turn.started', attribution: B, origin: 'echo' },
    ]);
    // Эхо, которого никто не ждал, хода не открывает.
    expect(n.push(line({ type: 'user', isReplay: true, uuid: 'other' }))).toEqual([]);
  });

  it('echo lines are ignored by the sequence rule; a stray user line opens nothing', () => {
    const n = new SdkNormaliser(QWEN);
    n.expect(A, A);
    expect(n.push(line({ type: 'user', isReplay: true, uuid: A }))).toEqual([]);
    expect(n.push(line({ type: 'command_lifecycle', state: 'started', command_uuid: A }))).toEqual(
      [],
    );
    expect(n.push(line({ type: 'user', message: { content: 'text' } }))).toEqual([]);
    expect(n.push(line({ type: 'user', message: { content: [{ type: 'text' }] } }))).toEqual([]);
    expect(n.waiting).toBe(1);
  });

  it('usage parts merge by message id and are reported once', () => {
    const n = new SdkNormaliser(QWEN);
    n.push(
      line({
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'm', usage: { input_tokens: 7, cache_creation_input_tokens: 2 } },
        },
      }),
    );
    n.push(
      line({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } }),
    );
    n.push(
      line({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } },
      }),
    );
    n.push(line({ type: 'stream_event', event: { type: 'ping' } }));
    const stop = n.push(line({ type: 'stream_event', event: { type: 'message_stop' } }));
    expect(stop).toEqual([
      {
        type: 'usage',
        messageId: 'm',
        input: 7,
        cacheRead: 0,
        cacheWrite: 2,
        cacheWrite1h: 0,
        output: 4,
      },
    ]);
    expect(n.push(line({ type: 'stream_event', event: { type: 'message_stop' } }))).toEqual([]);
    // Отказ с id вызова несёт его (W P-c: строка отказа сводится с вызовом), без id — без поля.
    expect(
      n.push(
        result(1, {
          permission_denials: [
            { tool_name: 'edit' },
            { tool_name: 'read_file', tool_use_id: 'call_1', tool_input: { file_path: 'a' } },
            'junk',
          ],
        }),
      ),
    ).toEqual([
      { type: 'ask', ask: expect.objectContaining({ action: 'edit', tool: 'edit' }), denied: true },
      {
        type: 'ask',
        ask: expect.objectContaining({ tool: 'read_file' }),
        denied: true,
        toolUseId: 'call_1',
      },
      { type: 'turn.cli-initiated', cause: 'background-wake', numTurns: 1 },
    ]);
  });

  it('an error result inside a turn ends it as an error, not as a session failure', () => {
    const n = new SdkNormaliser(QWEN);
    n.expect(A, A);
    n.push(init);
    expect(n.push(line({ type: 'result', subtype: 'error_max_turns', is_error: true }))).toEqual([
      {
        type: 'turn.ended',
        attribution: A,
        origin: 'sequence',
        isError: true,
        numTurns: 0,
        text: '',
      },
    ]);
    expect(
      n.push(line({ type: 'result', subtype: 'error_during_execution', is_error: true })),
    ).toEqual([{ type: 'error', code: 'model-error', detail: 'error_during_execution' }]);
  });

  it('protocol garbage is a protocol error; unknown line types are ignored', () => {
    const n = new SdkNormaliser(CLAUDE);
    expect(n.push('{oops')).toMatchObject([{ type: 'error', code: 'protocol' }]);
    expect(n.push('[1]')).toMatchObject([
      { type: 'error', code: 'protocol', detail: 'not an object' },
    ]);
    expect(
      n.push(line({ type: 'control_request', request: { subtype: 'can_use_tool' } })),
    ).toMatchObject([{ type: 'error', code: 'protocol', detail: 'control request without id' }]);
    expect(n.push(line({ type: 'control_request', request_id: 'r' }))).toEqual([]);
    expect(n.takeControl()).toEqual([{ requestId: 'r', subtype: '', request: {} }]);
    expect(n.push(line({ type: 'rate_limit_event' }))).toEqual([]);
    expect(n.push(line({ type: 'system', subtype: 'status' }))).toEqual([]);
    // Тот же разговор второй раз `init` не объявляет.
    n.push(
      line({
        type: 'system',
        subtype: 'init',
        session_id: 'c',
        mcp_servers: [{ name: 's', status: 'ok' }, 1],
      }),
    );
    expect(n.push(line({ type: 'system', subtype: 'init', session_id: 'c' }))).toEqual([]);
  });
});
