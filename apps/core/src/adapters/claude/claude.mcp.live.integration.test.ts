import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { sessionMcp, type McpPicks } from '../../bootstrap/session-road/mcp-list.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import {
  EventTap,
  hookCommand,
  liveRoot,
  livePin,
  liveSpec,
  PERMIT_SERVER,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import {
  CARRY_TOOL,
  carryLogs,
  MCP_DONE,
  PROBE_SERVER,
  readProbe,
  STRAY_TOOL,
  type ProbeEntry,
} from '../conformance/__fixtures__/mcp-carry-run.ts';
import { HUMAN_PICKED, HUMAN_UNPICKED } from '../conformance/__fixtures__/mcp-human-run.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';
import { claudeGlobalConfigFiles } from './trust.ts';

/**
 * Серверы MCP человека у НАСТОЯЩЕГО Claude Code через ядро (P73, паритет чата s10 p8). Ядро всегда
 * запускает CLI со `--strict-mcp-config`, поэтому свои серверы CLI сам не поднимет — их подаёт
 * ядро своим файлом `--mcp-config`. Цепочка от файла человека до запроса модели настоящая:
 * `.claude.json` дома → `claudeMcpSource` переходника → `sessionMcp` дороги (чат без
 * `mcpPicks.chat` берёт все предложенные, прочие виды — только выбранные) → `planClaude` →
 * `claude` против stub-model. Инструменты MCP CLI отдаёт отложенными (ToolSearch): имя — в перечне
 * отложенных, схема — после `select:`; модель так и делает, затем вызывает инструмент сервера.
 * Невыбранный сервер не стартует вовсе, хотя лежит там, где CLI искал бы его сам.
 * Нет `claude` в PATH (контейнер Linux) — пропуск с причиной.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const PICKED_TOOL = `mcp__${HUMAN_PICKED}__${CARRY_TOOL}`;
const UNPICKED_TOOL = `mcp__${HUMAN_UNPICKED}__${STRAY_TOOL}`;

/** Ответы инструментов в запросе anthropic-messages — блоки `tool_result`. */
const toolResults = (raw: string): number => (raw.match(/"type":"tool_result"/g) ?? []).length;

/** Модель: загрузить схему через ToolSearch, вызвать инструмент выбранного сервера, затем текст. */
function deferredScript(requests: string[]) {
  return (ctx: { request: { raw: string } }) => {
    requests.push(ctx.request.raw);
    const done = toolResults(ctx.request.raw);
    if (done === 0)
      return { tool: { name: 'ToolSearch', args: { query: `select:${PICKED_TOOL}` } } };
    if (done === 1) return { tool: { name: PICKED_TOOL, args: { note: 'carried' } } };
    return MCP_DONE;
  };
}

interface Seen {
  offered: string[];
  selected: string[];
  /** Все тела запросов модели подряд. */
  body: string;
  argv: string;
  picked: ProbeEntry[];
  unpicked: ProbeEntry[];
  text: string;
}

/** Два сервера человека в его `.claude.json`; дорога выбирает по `picks` вида `kind`; один ход. */
async function runHuman(prefix: string, kind: string, picks: McpPicks): Promise<Seen> {
  const live = liveRoot(prefix);
  roots.push(live);
  const logs = carryLogs(live);
  const pin = livePin(live);
  const server = (log: string, tool: string) => ({
    command: process.execPath,
    args: [PROBE_SERVER],
    env: { PROBE_LOG: log, PROBE_TOOL: tool },
  });
  const file = claudeGlobalConfigFiles(pin).main;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [HUMAN_PICKED]: server(logs.carried, CARRY_TOOL),
        [HUMAN_UNPICKED]: server(logs.stray, STRAY_TOOL),
      },
    }),
  );
  const adapter = createClaudeAdapter();
  const read = adapter.mcpSource?.({ pin, cwd: live.cwd });
  if (!read) throw new Error('claude adapter has no mcpSource');
  const human = sessionMcp(kind, 'stub', read, picks).human;

  const requests: string[] = [];
  const stub = await startStubModel({ script: deferredScript(requests) });
  stubs.push(stub);
  const spec = liveSpec(live, {
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'MCP-ROUTE-TOKEN',
      },
    },
    coreHook: hookCommand('core', live.logs.core),
    // Сервер права — как его ставит дорога: вопрос о праве на инструмент MCP идёт ему (здесь «да»).
    permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    mcpServers: {
      ...human,
      'agentdeck-permit': {
        command: process.execPath,
        args: [PERMIT_SERVER],
        env: { PERMIT_DECISION: 'allow', PERMIT_LOG: live.logs.permit },
      },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  let text: string;
  try {
    await adapter.send(launched.handle, 'call the carry probe', 'cmd-mcp-1');
    const ended = await tap.until((e) => e.type === 'turn.ended', 120_000);
    text = 'text' in ended && typeof ended.text === 'string' ? ended.text : '';
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  return {
    offered: read.servers.filter((s) => s.entry).map((s) => s.id),
    selected: Object.keys(human),
    body: requests.join('\n'),
    argv: launched.handle.spawned.argv.join(' '),
    picked: readProbe(logs.carried),
    unpicked: readProbe(logs.stray),
    text,
  };
}

const diagOf = (seen: Seen): string =>
  JSON.stringify({ ...seen, body: seen.body.length, argv: seen.argv.slice(0, 300) });

describe.skipIf(!present)('claude adapter on the real CLI — the human MCP servers', () => {
  it('chat without mcpPicks.chat: both servers of ~/.claude.json reach the model through the core --mcp-config; the model calls one', async () => {
    const seen = await runHuman('claude-mcp-chat-', 'chat', {});
    const diag = diagOf(seen);
    expect(seen.offered.sort(), diag).toEqual([HUMAN_PICKED, HUMAN_UNPICKED]);
    expect(seen.selected.sort(), diag).toEqual([HUMAN_PICKED, HUMAN_UNPICKED]);
    expect(seen.argv).toContain('--strict-mcp-config');
    expect(seen.argv).toContain('--mcp-config');
    expect(seen.body, diag).toContain(PICKED_TOOL);
    expect(seen.body, diag).toContain(UNPICKED_TOOL);
    expect(
      seen.picked.filter((e) => e.event === 'call'),
      diag,
    ).toEqual([expect.objectContaining({ tool: CARRY_TOOL, args: { note: 'carried' } })]);
    expect(seen.text, diag).toBe(MCP_DONE);
  }, 200_000);

  it('a step that picked one server: only it reaches the model; the unpicked never starts', async () => {
    const seen = await runHuman('claude-mcp-work-', 'work', { work: [HUMAN_PICKED] });
    const diag = diagOf(seen);
    expect(seen.selected, diag).toEqual([HUMAN_PICKED]);
    expect(seen.body, diag).toContain(PICKED_TOOL);
    expect(seen.body, diag).not.toContain(STRAY_TOOL);
    expect(seen.unpicked, 'the unpicked human server started').toEqual([]);
  }, 200_000);
});
