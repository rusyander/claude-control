import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../../adapters/index.ts';
import {
  agentsJournalRows,
  readAgentsJournal,
  toFixture,
  writeAgentsJournal,
} from '../../adapters/claude/__fixtures__/agents-journal.ts';
import { createClaudeAdapter } from '../../adapters/claude/claude.ts';
import { createQwenAdapter } from '../../adapters/qwen/qwen.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { createTaskRegistry } from '../../conductor/tasks.ts';
import { CREATED, deps, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import type { MaskFn } from '../../journal/journal.types.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { createEconomyWiring } from '../economy-wiring/index.ts';
import { createSessionRuntime } from '../session-runtime.ts';
import { createToolEventTap } from './tool-events.ts';

/**
 * История агентов из потока (этап 11, P146-P149) через НАСТОЯЩИЕ нормализатор переходника
 * (`streamNormaliser` — то же правило, что у живого насоса), рантайм сессии, краны наблюдателя
 * и экономики и журнал задачи. Вход — записи живых CLI (`s8-probe.jsonl`, `bg-permit-allow.jsonl`):
 * строки `tool.started` / `agent.*` / `bg.*` и родитель хода в `turn.usage` берутся только из них.
 */

const CONTEXT: PermitContext = {
  copyRoot: '/copy',
  ownedPaths: [],
  deny: { paths: [], commands: [], mcpTools: [], tools: [] },
  platformPaths: [],
  endpointSources: [],
  grantRequired: [],
  grants: [],
};

const WALL = 1_800_000_000_000;
const AGENT_KINDS = new Set(['agent.spawned', 'agent.ended', 'bg.started', 'bg.ended']);

const fixtureLines = (cli: 'claude' | 'qwen', name: string): string[] =>
  readFileSync(join(import.meta.dirname, '../../adapters', cli, '__fixtures__', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');

/** Запись через нормализатор переходника; конец сеанса — как у насоса (`flushTasks`). */
function normalise(adapter: CliAdapter, lines: string[]): AdapterEvent[] {
  const n = adapter.streamNormaliser!('') as unknown as {
    push(line: string): AdapterEvent[];
    flushTasks?(): AdapterEvent[];
  };
  const out = lines.flatMap((line) => n.push(line));
  return [...out, ...(n.flushTasks?.() ?? [])];
}

function adapterOf(real: CliAdapter, events: AdapterEvent[]): CliAdapter {
  return {
    id: real.id,
    events: async function* () {
      for (const event of events) yield event;
    },
    mapPermission: (raw: Parameters<CliAdapter['mapPermission']>[0]) => real.mapPermission(raw),
  } as unknown as CliAdapter;
}

async function run(adapter: CliAdapter, events: AdapterEvent[], mask?: MaskFn) {
  const registry = createTaskRegistry(tempDir('agent-ev-'), deps(mask ? { mask } : {}));
  const task = await registry.create(CREATED);
  const { sessionId } = seedSession(task, { stepKind: 'work' });
  const got = bindingOf(task, sessionId);
  if (!('binding' in got)) throw new Error(got.reason);
  const notes: string[] = [];
  let clock = 1_000;
  const tap = createToolEventTap({
    sessionOf: () => ({ mapPermission: (raw) => adapter.mapPermission(raw), cwd: null }),
    now: () => (clock += 10),
    wall: () => WALL,
  });
  await createSessionRuntime({
    note: (e) => notes.push(e),
    observer: tap,
    economy: createEconomyWiring({ now: () => WALL }),
  }).attach({
    task,
    binding: got.binding,
    adapter: adapterOf(adapter, events),
    handle: { sessionId } as SessionHandle,
    context: CONTEXT,
    onEvent: () => {},
  }).done;
  expect(notes.filter((n) => n.endsWith('.tap.failed'))).toEqual([]);
  const lines = readJournalLines(task.dir, task.taskId).lines;
  registry.closeAll();
  return { task, binding: got.binding, lines };
}

const ofKind = <K extends string>(lines: readonly JournalLine[], kind: K) =>
  lines.filter((l) => l.kind === kind).map((l) => l.data as Record<string, unknown>);

/** Каждый вызов: `tool.started` один раз и раньше своего `tool.event`. */
function startedBeforeEvents(lines: readonly JournalLine[], requested: string[]) {
  const seqOf = (kind: string, id: string) =>
    lines
      .filter((l) => l.kind === kind && (l.data as { toolUseId?: string }).toolUseId === id)
      .map((l) => l.seq);
  for (const id of requested) {
    const started = seqOf('tool.started', id);
    expect(started, `tool.started ${id}`).toHaveLength(1);
    for (const at of seqOf('tool.event', id)) expect(started[0]!).toBeLessThan(at);
  }
}

const requestedIds = (events: AdapterEvent[]) => [
  ...new Set(
    events.flatMap((e) => (e.type === 'tool.requested' && e.toolUseId ? [e.toolUseId] : [])),
  ),
];

const LIVE_S8 = String.raw`<live>\sessions\s1\tmp\claude\C--ProgramData-agentdeck-live-s8m-s8-claude-Bd0Bwo-work\f2c3dc26-6de5-4e3a-86df-dc639bfa6a9b\tasks`;

describe('stage 11 agent-history facts from the stream (real normaliser → session runtime → journal)', () => {
  it('claude s8 probe: subagent spawn/end with usage, background shell with output file and full owner chain, foreground Bash gives nothing, tool.started before each tool.event', async () => {
    const adapter = createClaudeAdapter();
    const events = normalise(adapter, fixtureLines('claude', 's8-probe.jsonl'));
    const { task, binding, lines } = await run(adapter, events);
    const chain = (toolUseId: string) => ({
      taskId: task.taskId,
      stepId: binding.stepId,
      unitId: binding.unitId,
      sessionId: binding.sessionId,
      toolUseId,
      parentToolUseId: null,
    });
    expect(lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => [l.kind, l.data])).toEqual([
      [
        'bg.started',
        {
          itemId: 'b8ul3rdfv',
          kind: 'background-shell',
          excerpt: 'node -e "setTimeout(()=>console.log(String.fromCharCode(66,71)),3000)"',
          ownerChain: chain('toolu_stub_9_0'),
          outputFile: `${LIVE_S8}\\b8ul3rdfv.output`,
          // Время строки результата вызова, которой CLI назвал запуск (не стена записи).
          startedAt: Date.parse('2026-10-31T18:11:38.201Z'),
        },
      ],
      [
        'bg.ended',
        {
          itemId: 'b8ul3rdfv',
          how: 'exit',
          exitCode: 0,
          endedAt: 1793470301328,
          summary: 'Background command "background job" completed (exit code 0)',
        },
      ],
      [
        'agent.spawned',
        {
          sessionId: binding.sessionId,
          toolUseId: 'toolu_stub_12_0',
          parentToolUseId: null,
          cliTaskId: 'a51df7f9c80efa23a',
          kind: 'subagent',
          subagentType: 'general-purpose',
          model: null,
          effort: null,
          background: true,
          depth: 1,
          briefExcerpt: String.raw`PROBE_SUB read <live>\work\big.txt`,
        },
      ],
      [
        'agent.ended',
        {
          sessionId: binding.sessionId,
          toolUseId: 'toolu_stub_12_0',
          cliTaskId: 'a51df7f9c80efa23a',
          how: 'completed',
          usage: { totalTokens: 15, toolUses: 1, durationMs: 249 },
          summaryExcerpt: 'DONE PROBE_SUB',
        },
      ],
    ]);
    // Обычный (не фоновый) Bash с `task_started{is_backgrounded:false}` — ни узла, ни конца.
    expect(JSON.stringify(lines.filter((l) => AGENT_KINDS.has(l.kind)))).not.toContain('bp19ylutp');
    startedBeforeEvents(lines, requestedIds(events));
    expect(ofKind(lines, 'tool.started').find((d) => d.toolUseId === 'toolu_stub_14_0')).toEqual({
      sessionId: binding.sessionId,
      toolUseId: 'toolu_stub_14_0',
      parentToolUseId: 'toolu_stub_12_0',
      tool: 'Read',
      target: expect.stringContaining('big.txt'),
    });
  });

  it('claude s8 probe: subagent turn.usage rows keep the parent call, main-context rows carry null', async () => {
    const adapter = createClaudeAdapter();
    const { lines } = await run(
      adapter,
      normalise(adapter, fixtureLines('claude', 's8-probe.jsonl')),
    );
    // Ходы субагента — с вызовом-родителем, главный контекст — `null` (P149).
    const usage = ofKind(lines, 'turn.usage').filter((d) => d.remainder === false);
    const parentOf = (id: string) => usage.find((d) => d.messageId === id)?.parentToolUseId;
    expect(parentOf('msg_stub_14')).toBe('toolu_stub_12_0');
    expect(parentOf('msg_stub_15')).toBe('toolu_stub_12_0');
    expect(parentOf('msg_stub_9')).toBeNull();
    expect(usage.every((d) => d.parentToolUseId !== undefined)).toBe(true);
  });

  it('claude bg-permit-allow: an allowed background Bash is one bg item with its output file and an exit end', async () => {
    const adapter = createClaudeAdapter();
    const events = normalise(adapter, fixtureLines('claude', 'bg-permit-allow.jsonl'));
    const { task, binding, lines } = await run(adapter, events);
    expect(lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => [l.kind, l.data])).toEqual([
      [
        'bg.started',
        {
          itemId: 'bnc1pzgb6',
          kind: 'background-shell',
          excerpt: 'node -e "setTimeout(()=>console.log(1),1500)"',
          ownerChain: {
            taskId: task.taskId,
            stepId: binding.stepId,
            unitId: binding.unitId,
            sessionId: binding.sessionId,
            toolUseId: 'toolu_stub_1_0',
            parentToolUseId: null,
          },
          outputFile: String.raw`<live>\sessions\s1\tmp\claude\<live-project>\625b568d-8498-4c01-829d-480c99145800\tasks\bnc1pzgb6.output`,
          startedAt: Date.parse('2026-10-28T07:16:37.260Z'),
        },
      ],
      [
        'bg.ended',
        {
          itemId: 'bnc1pzgb6',
          how: 'exit',
          exitCode: 0,
          endedAt: 1793171798878,
          summary: 'Background command "bg" completed (exit code 0)',
        },
      ],
    ]);
    startedBeforeEvents(lines, requestedIds(events));
  });

  it('qwen s8 probe: agent launched in background by default with its usage, is_background shell is a bg item named by its bg id and pid', async () => {
    const adapter = createQwenAdapter();
    const events = normalise(adapter, fixtureLines('qwen', 's8-probe.jsonl'));
    const { task, binding, lines } = await run(adapter, events);
    expect(lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => [l.kind, l.data])).toEqual([
      [
        'bg.started',
        {
          itemId: 'bg_e43074da',
          kind: 'background-shell',
          excerpt: 'node -e "setTimeout(()=>console.log(String.fromCharCode(66,71)),3000)"',
          ownerChain: {
            taskId: task.taskId,
            stepId: binding.stepId,
            unitId: binding.unitId,
            sessionId: binding.sessionId,
            toolUseId: 'call_stub_9_0',
            parentToolUseId: null,
          },
          pid: 69568,
          startedAt: WALL,
        },
      ],
      [
        'agent.spawned',
        {
          sessionId: binding.sessionId,
          toolUseId: 'call_stub_11_0',
          parentToolUseId: null,
          cliTaskId: 'general-purpose-call_stub_11_0',
          kind: 'subagent',
          subagentType: 'general-purpose',
          model: null,
          effort: null,
          background: true,
          depth: null,
          briefExcerpt: String.raw`PROBE_SUB read <live>\work\big.txt`,
        },
      ],
      [
        'agent.ended',
        {
          sessionId: binding.sessionId,
          toolUseId: 'call_stub_11_0',
          cliTaskId: 'general-purpose-call_stub_11_0',
          how: 'completed',
          usage: { totalTokens: 24, toolUses: 1, durationMs: 337 },
          summaryExcerpt: null,
        },
      ],
    ]);
    startedBeforeEvents(lines, requestedIds(events));
    const usage = ofKind(lines, 'turn.usage').filter((d) => d.remainder === false);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((d) => d.parentToolUseId === null)).toBe(true);
  });

  it('claude agents probe (live Agent model sonnet + background Bash): rows as recorded, equal to the I2 seam fixture agents-journal.jsonl', async () => {
    const adapter = createClaudeAdapter();
    const events = normalise(adapter, fixtureLines('claude', 'agents-probe.jsonl'));
    const { task, binding, lines } = await run(adapter, events);
    const kinds = lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => l.kind);
    expect(kinds).toEqual(['agent.spawned', 'agent.ended', 'bg.started', 'bg.ended']);
    expect(ofKind(lines, 'agent.spawned')[0]).toMatchObject({
      toolUseId: 'toolu_stub_1_0',
      model: 'sonnet',
      subagentType: 'general-purpose',
      background: true,
      depth: 1,
    });
    expect(ofKind(lines, 'bg.started')[0]).toMatchObject({
      itemId: 'b1zqng9u1',
      ownerChain: { toolUseId: 'toolu_stub_2_0', unitId: binding.unitId },
      outputFile: expect.stringMatching(/b1zqng9u1\.output$/),
    });
    expect(ofKind(lines, 'bg.ended')[0]).toMatchObject({ how: 'exit', exitCode: 0 });
    startedBeforeEvents(lines, requestedIds(events));
    const ids = {
      taskId: task.taskId,
      stepId: binding.stepId,
      unitId: binding.unitId,
      sessionId: binding.sessionId,
    };
    const text = toFixture(lines, ids);
    if (process.env.AGENTS_JOURNAL_WRITE === '1') writeAgentsJournal(text);
    expect(text).toBe(readAgentsJournal());
    // Файл шва годен свёртке: строки со своими id проходят схему журнала при записи.
    const registry = createTaskRegistry(tempDir('agent-ev-seam-'), deps());
    const other = await registry.create(CREATED);
    const seeded = seedSession(other, { stepKind: 'work' });
    const bound = bindingOf(other, seeded.sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const rows = agentsJournalRows({
      taskId: other.taskId,
      stepId: bound.binding.stepId,
      unitId: bound.binding.unitId,
      sessionId: seeded.sessionId,
    });
    for (const row of rows) other.append(row as Parameters<typeof other.append>[0]);
    expect(
      readJournalLines(other.dir, other.taskId).lines.filter((l) => AGENT_KINDS.has(l.kind)),
    ).toHaveLength(4);
    registry.closeAll();
  });

  it('a brief is masked before it is cut: a secret across the 2000-char edge leaves no prefix', async () => {
    const adapter = createClaudeAdapter();
    const secret = 'sk-SECRET-0123456789';
    const mask: MaskFn = (text) => ({
      text: text.split(secret).join('[masked]'),
      count: text.split(secret).length - 1,
    });
    const brief = `${'x'.repeat(1990)}${secret}`;
    const events: AdapterEvent[] = [
      {
        type: 'tool.requested',
        toolUseId: 'toolu_a',
        name: 'Agent',
        input: { prompt: brief, model: 'sonnet' },
        cliInitiated: false,
        parentToolUseId: null,
      },
      {
        type: 'agent.spawned',
        cliTaskId: 'task_a',
        toolUseId: 'toolu_a',
        parentToolUseId: null,
        kind: 'subagent',
        subagentType: 'general-purpose',
        model: 'sonnet',
        effort: null,
        background: false,
        depth: 1,
        brief,
      } as AdapterEvent,
    ];
    const { lines } = await run(adapter, events, mask);
    const [spawned] = ofKind(lines, 'agent.spawned');
    expect(spawned?.briefExcerpt).toBe(`${'x'.repeat(1990)}[masked]`);
    expect(spawned?.model).toBe('sonnet');
  });

  it('unknown task types: a foreground one is a node of kind other named by its type, a backgrounded one a bg item of kind other with the type in its excerpt; each ends with its how', async () => {
    const adapter = createClaudeAdapter();
    // Строки в форме записи 2.1.310 (`agents-probe.jsonl`), типы задач — незнакомые ядру.
    const use = (id: string, name: string, input: Record<string, unknown>, msg: string) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id: msg,
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [{ type: 'tool_use', id, name, input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
      });
    const sys = (subtype: string, fields: Record<string, unknown>) =>
      JSON.stringify({ type: 'system', subtype, ...fields });
    const events = normalise(adapter, [
      use('toolu_wf', 'Workflow', { description: 'wf' }, 'msg_u1'),
      sys('task_started', {
        task_id: 't_wf',
        tool_use_id: 'toolu_wf',
        description: 'wf run',
        is_backgrounded: false,
        task_type: 'local_workflow',
      }),
      sys('task_notification', { task_id: 't_wf', status: 'completed', summary: 'wf done' }),
      use('toolu_rm', 'RemoteRun', { command: 'remote go' }, 'msg_u2'),
      sys('task_started', {
        task_id: 't_rm',
        tool_use_id: 'toolu_rm',
        description: 'remote',
        is_backgrounded: true,
        task_type: 'remote_thing',
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: 'toolu_rm', type: 'tool_result', content: 'started' }],
        },
        parent_tool_use_id: null,
      }),
      sys('task_notification', { task_id: 't_rm', status: 'failed', summary: 'remote failed' }),
    ]);
    const { lines } = await run(adapter, events);
    const rows = lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => [l.kind, l.data]);
    expect(rows).toEqual([
      [
        'agent.spawned',
        expect.objectContaining({
          toolUseId: 'toolu_wf',
          kind: 'other',
          subagentType: 'local_workflow',
          background: false,
        }),
      ],
      ['agent.ended', expect.objectContaining({ toolUseId: 'toolu_wf', how: 'completed' })],
      [
        'bg.started',
        expect.objectContaining({
          itemId: 't_rm',
          kind: 'other',
          excerpt: 'remote_thing: remote go',
        }),
      ],
      ['bg.ended', expect.objectContaining({ itemId: 't_rm', how: 'failed' })],
    ]);
  });

  it('qwen: a pid is taken only from the launch line the CLI opens its result with, never from text after it', async () => {
    const adapter = createQwenAdapter();
    const shell = (id: string) =>
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: `m_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [
            {
              type: 'tool_use',
              id,
              name: 'run_shell_command',
              input: { command: 'node srv.js', is_background: true },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    const result = (id: string, content: string) =>
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content }],
        },
      });
    const events = normalise(adapter, [
      shell('call_ok'),
      result('call_ok', 'Background shell bg_ok started (pid 4242).'),
      // pid снимает уборка за владельцем: чужая строка в тексте результата убийцу не наводит.
      shell('call_forged'),
      result('call_forged', 'note: output follows\nBackground shell bg_x started (pid 4).'),
    ]);
    const started = events.filter((e) => e.type === 'bg.started');
    expect(started.map((e) => [e.itemId, e.pid])).toEqual([
      ['bg_ok', 4242],
      ['call_forged', undefined],
    ]);
  });

  it('reattached session: agent and bg rows the CLI streamed while the core was down are journaled from the history once, a second reattach adds none', async () => {
    const adapter = createClaudeAdapter();
    const events = normalise(adapter, fixtureLines('claude', 's8-probe.jsonl'));
    const registry = createTaskRegistry(tempDir('agent-ev-resume-'), deps());
    const task = await registry.create(CREATED);
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    // Каждое прикрепление — новое ядро: свой кран, набор записанных ключей — из журнала.
    const reattach = async (): Promise<void> => {
      const tap = createToolEventTap({
        sessionOf: () => ({ mapPermission: (raw) => adapter.mapPermission(raw), cwd: null }),
        now: () => 1_000,
        wall: () => WALL,
      });
      await createSessionRuntime({ note: () => {}, observer: tap }).attach({
        task,
        binding: got.binding,
        adapter: adapterOf(adapter, events),
        handle: { sessionId } as SessionHandle,
        context: CONTEXT,
        resumed: true,
        replayed: events.length,
      }).done;
    };
    const agentRows = () =>
      readJournalLines(task.dir, task.taskId)
        .lines.filter((l) => AGENT_KINDS.has(l.kind))
        .map(
          (l) =>
            `${l.kind} ${JSON.stringify(l.data).match(/"(?:itemId|toolUseId)":"([^"]+)"/)?.[1]}`,
        );
    // Ядро лежало, пока CLI писал поток: вся запись — история нового прикрепления.
    await reattach();
    const first = agentRows();
    expect(first).toEqual([
      'bg.started b8ul3rdfv',
      'bg.ended b8ul3rdfv',
      'agent.spawned toolu_stub_12_0',
      'agent.ended toolu_stub_12_0',
    ]);
    // Начало фона из истории — время строки результата вызова, не стена прикрепления (WALL позже
    // конца, названного CLI): начало не позже конца.
    const bgRow = (kind: string) =>
      readJournalLines(task.dir, task.taskId).lines.find((l) => l.kind === kind)!.data as {
        startedAt?: number;
        endedAt?: number;
      };
    expect(bgRow('bg.started').startedAt).toBe(Date.parse('2026-10-31T18:11:38.201Z'));
    expect(bgRow('bg.ended').endedAt).toBe(1793470301328);
    await reattach();
    expect(agentRows()).toEqual(first);
    registry.closeAll();
  });

  it('bg start time: a stream without line times never journals a start later than its end — a task ended before its result starts at that end, a history start written at the attach wall raises its end to it', async () => {
    const adapter = createClaudeAdapter();
    const use = (id: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id: `m_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [{ type: 'tool_use', id, name: 'Bash', input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
      });
    const sys = (subtype: string, fields: Record<string, unknown>) =>
      JSON.stringify({ type: 'system', subtype, ...fields });
    const result = (id: string) =>
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ tool_use_id: id, type: 'tool_result', content: `running ${id}` }],
        },
        parent_tool_use_id: null,
      });
    const END = WALL - 60_000;
    const events = normalise(adapter, [
      // Конец пришёл раньше результата вызова: строка начала выходит с концом.
      use('tu_a', { command: 'sleep 1', run_in_background: true }),
      sys('task_started', {
        task_id: 'ba',
        tool_use_id: 'tu_a',
        is_backgrounded: true,
        task_type: 'local_bash',
      }),
      sys('task_updated', { task_id: 'ba', patch: { status: 'completed', end_time: END } }),
      sys('task_notification', { task_id: 'ba', status: 'completed', summary: 'done' }),
      // Результат без времени строки, конец позже — из истории (вся запись — история).
      use('tu_b', { command: 'sleep 2', run_in_background: true }),
      sys('task_started', {
        task_id: 'bb',
        tool_use_id: 'tu_b',
        is_backgrounded: true,
        task_type: 'local_bash',
      }),
      result('tu_b'),
      sys('task_updated', { task_id: 'bb', patch: { status: 'completed', end_time: END + 1 } }),
      sys('task_notification', { task_id: 'bb', status: 'completed', summary: 'done' }),
    ]);
    const registry = createTaskRegistry(tempDir('agent-ev-time-'), deps());
    const task = await registry.create(CREATED);
    const { sessionId } = seedSession(task, { stepKind: 'work' });
    const got = bindingOf(task, sessionId);
    if (!('binding' in got)) throw new Error(got.reason);
    const tap = createToolEventTap({
      sessionOf: () => ({ mapPermission: (raw) => adapter.mapPermission(raw), cwd: null }),
      now: () => 1_000,
      wall: () => WALL,
    });
    await createSessionRuntime({ note: () => {}, observer: tap }).attach({
      task,
      binding: got.binding,
      adapter: adapterOf(adapter, events),
      handle: { sessionId } as SessionHandle,
      context: CONTEXT,
      resumed: true,
      replayed: events.length,
    }).done;
    const lines = readJournalLines(task.dir, task.taskId).lines;
    registry.closeAll();
    const times = (itemId: string) => {
      const of = (kind: string) =>
        lines.find((l) => l.kind === kind && (l.data as { itemId: string }).itemId === itemId)!
          .data as { startedAt?: number; endedAt?: number };
      return [of('bg.started').startedAt, of('bg.ended').endedAt];
    };
    expect(times('ba')).toEqual([END, END]);
    // Начало без времени строки уже записано стеной прикрепления (журнал дописывается) — конец
    // не раньше него.
    expect(times('bb')).toEqual([WALL, WALL]);
  });

  it('older CLI: a shell task line without is_backgrounded is background when its call asked run_in_background, foreground otherwise', async () => {
    const adapter = createClaudeAdapter();
    const use = (id: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id: `m_${id}`,
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [{ type: 'tool_use', id, name: 'Bash', input }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
      });
    const sys = (subtype: string, fields: Record<string, unknown>) =>
      JSON.stringify({ type: 'system', subtype, ...fields });
    const events = normalise(adapter, [
      use('tu_bg', { command: 'npm run dev', run_in_background: true }),
      sys('task_started', { task_id: 'b_old', tool_use_id: 'tu_bg', task_type: 'local_bash' }),
      sys('task_notification', { task_id: 'b_old', status: 'completed', summary: 'done' }),
      use('tu_fg', { command: 'ls' }),
      sys('task_started', { task_id: 'f_old', tool_use_id: 'tu_fg', task_type: 'local_bash' }),
      sys('task_notification', { task_id: 'f_old', status: 'completed', summary: 'done' }),
    ]);
    const { lines } = await run(adapter, events);
    const rows = lines.filter((l) => AGENT_KINDS.has(l.kind)).map((l) => [l.kind, l.data]);
    expect(rows).toEqual([
      [
        'bg.started',
        expect.objectContaining({
          itemId: 'b_old',
          kind: 'background-shell',
          excerpt: 'npm run dev',
        }),
      ],
      ['bg.ended', expect.objectContaining({ itemId: 'b_old', how: 'exit' })],
    ]);
  });
});
