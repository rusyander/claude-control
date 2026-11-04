import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexRunFacts } from '@agentdeck/providers/codex';
import { gooseRunFacts } from '@agentdeck/providers/goose';
import { kimiRunFacts } from '@agentdeck/providers/kimi';
import { opencodeRunFacts } from '@agentdeck/providers/opencode';
import { startStubModel } from '@agentdeck/stub-model';
import type { AdapterChannelSummary, BoundEndpoint, CliAdapter } from '../adapter.types.ts';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { createCodexAdapter, CODEX_CHANNELS } from '../codex/codex.ts';
import { createGooseAdapter, GOOSE_CHANNELS } from '../goose/goose.ts';
import { createKimiAdapter, KIMI_CHANNELS } from '../kimi/kimi.ts';
import { createOpencodeAdapter, OPENCODE_CHANNELS } from '../opencode/opencode.ts';
import { liveRoot, type LiveRoot } from './__fixtures__/live.ts';
import {
  CARRIED,
  CARRY_TOOL,
  carryLogs,
  PROBE_SERVER,
  readProbe,
  requestTools,
  toolRefs,
} from './__fixtures__/mcp-carry-run.ts';
import { P81_ATTRIBUTION, runP81Mode, toolTurns } from './__fixtures__/p81-run.ts';
import { startFakeCore, type FakeCore } from './__fixtures__/p81-stand.ts';

/**
 * Сеанс без инструментов (`tools: 'none'`, вопрос «ask», s10 p10) на настоящих Codex, Goose,
 * opencode и Kimi: в запросе модели нет ни одного встроенного инструмента, а вызов встроенной
 * оболочки, который модель всё же делает (`git status` в подставной git), ничего не исполняет —
 * журнал подставного git пуст. Сервер MCP шага остаётся и вызывается: «без инструментов» снимает
 * встроенные, не инструменты шага. Codex с сервером MCP добавляет свои читатели ресурсов MCP —
 * они ходят только в серверы шага и названы здесь поимённо, а не скрыты фильтром.
 */

interface Cli {
  id: string;
  present: boolean;
  make: () => CliAdapter;
  channel: AdapterChannelSummary;
  dialect: BoundEndpoint['dialect'];
  /** Вызов встроенной оболочки этого CLI — то, чего в сеансе без инструментов быть не может. */
  shell: { name: string; args: Record<string, unknown> };
  /** Сколько ответов инструментов уже в запросе (шаг сценария). */
  outputs: (raw: string) => number;
  /** Инструменты CLI для серверов MCP шага (не встроенные в смысле `none`). */
  mcpPlumbing: readonly string[];
}

const responsesOutputs = (raw: string): number => (raw.match(/function_call_output/g) ?? []).length;

const CLIS: Cli[] = [
  {
    id: 'codex',
    present: hasCli(codexRunFacts.binary.command),
    make: () => createCodexAdapter({ pollMs: 20 }),
    channel: CODEX_CHANNELS[0]!,
    dialect: 'openai-responses',
    shell: { name: 'exec_command', args: { cmd: 'git status' } },
    outputs: responsesOutputs,
    mcpPlumbing: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
  },
  {
    id: 'goose',
    present: hasCli(gooseRunFacts.binary.command),
    make: () => createGooseAdapter({ pollMs: 20 }),
    channel: GOOSE_CHANNELS[0]!,
    dialect: 'openai-chat',
    shell: { name: 'shell', args: { command: 'git status' } },
    outputs: toolTurns,
    mcpPlumbing: [],
  },
  {
    id: 'opencode',
    present: hasCli(opencodeRunFacts.binary.command),
    make: () => createOpencodeAdapter({ pollMs: 20 }),
    channel: OPENCODE_CHANNELS[0]!,
    dialect: 'openai-chat',
    shell: { name: 'bash', args: { command: 'git status', description: 'status' } },
    outputs: toolTurns,
    mcpPlumbing: [],
  },
  {
    id: 'kimi',
    present: hasCli(kimiRunFacts.binary.command),
    make: () => createKimiAdapter({ pollMs: 20 }),
    channel: KIMI_CHANNELS[0]!,
    dialect: 'openai-chat',
    shell: { name: 'Bash', args: { command: 'git status' } },
    outputs: toolTurns,
    mcpPlumbing: [],
  },
];

const PROMPT = 'run the two commands';
const NONE_DONE = 'NONE_DONE';

let core: FakeCore;
const roots: LiveRoot[] = [];

beforeAll(async () => {
  if (CLIS.some((c) => c.present)) core = await startFakeCore();
}, 60_000);

afterAll(async () => {
  await core?.close();
  for (const r of roots) rmSync(r.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

for (const cli of CLIS) {
  describe.skipIf(!cli.present)(`${cli.id} on the real CLI — tools none (s10 p10)`, () => {
    it('the model request carries no built-in tool, a built-in shell call runs nothing, the step MCP server is still called', async () => {
      const live = liveRoot(`tools-none-${cli.id}-`);
      roots.push(live);
      const logs = carryLogs(live);
      const requests: string[] = [];
      // Модель: сначала встроенная оболочка (её нет), затем инструмент сервера шага, затем текст.
      const stub = await startStubModel({
        script: (ctx) => {
          const raw = ctx.request.raw;
          requests.push(raw);
          if (!raw.includes(PROMPT)) return 'TITLE';
          const done = cli.outputs(raw);
          if (done === 0) return { tool: cli.shell };
          if (done === 1) {
            const ref = toolRefs(raw).find((r) => r.name.includes(CARRY_TOOL));
            if (!ref) return `NO_CARRIED_TOOL ${requestTools(raw).join(',')}`;
            return {
              tool: {
                name: ref.name,
                ...(ref.namespace ? { namespace: ref.namespace } : {}),
                args: { note: 'carried' },
              },
            };
          }
          return NONE_DONE;
        },
      });
      try {
        const got = await runP81Mode({
          live,
          core,
          adapter: cli.make(),
          channel: cli.channel,
          dialect: cli.dialect,
          baseUrl: stub.baseUrl,
          index: 0,
          mode: {
            name: 'tools none',
            over: () => ({
              tools: 'none',
              mcpServers: {
                [CARRIED]: {
                  command: process.execPath,
                  args: [PROBE_SERVER],
                  env: { PROBE_LOG: logs.carried, PROBE_TOOL: CARRY_TOOL },
                },
              },
            }),
            hook: 'core',
            // Каждый вопрос о праве — «да»: не исполнилось только потому, что инструмента нет.
            answer: 'all',
          },
          keep: ['TEMP', 'TMP', 'PATHEXT', 'ComSpec'],
        });
        const turn = requests.filter((raw) => raw.includes(PROMPT));
        const offered = [...new Set(turn.flatMap(requestTools))];
        const builtins = offered.filter(
          (name) => !name.includes(CARRY_TOOL) && !cli.mcpPlumbing.includes(name),
        );
        const calls = readProbe(logs.carried).filter((e) => e.event === 'call');
        const diag = `${got.seen.map((e) => e.type).join(',')} offered=${offered} marker=${JSON.stringify(got.marker)} calls=${calls.length}`;
        expect(turn.length, diag).toBeGreaterThan(0);
        expect(builtins, diag).toEqual([]);
        expect(
          offered.some((name) => name.includes(CARRY_TOOL)),
          diag,
        ).toBe(true);
        // Подставной git пишет журнал на каждый вызов: пуст — оболочка не исполнялась.
        expect(got.marker, diag).toBe('');
        expect(calls, diag).toHaveLength(1);
        expect(
          got.seen.find((e) => e.type === 'turn.ended'),
          diag,
        ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: NONE_DONE });
      } finally {
        await stub.close();
      }
    }, 240_000);
  });
}
