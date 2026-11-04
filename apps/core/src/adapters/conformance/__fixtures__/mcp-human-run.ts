import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { McpServerEntry } from '../../adapter.types.ts';
import type { McpSourceRead } from '../../mcp-source/mcp-source.ts';
import type { LiveRoot } from './live.ts';
import { livePin } from './live.ts';
import {
  CARRY_TOOL,
  carryLogs,
  PROBE_SERVER,
  readProbe,
  requestTools,
  STRAY_TOOL,
  type CarryRunInput,
  type CarryRunResult,
} from './mcp-carry-run.ts';
import { runP81Mode } from './p81-run.ts';

/**
 * Сервер MCP ЧЕЛОВЕКА в чужом CLI на настоящем CLI (P73, s10 p7): в конфиг MCP самого CLI (дом
 * `live.home`, формат и место этого CLI) посажены два сервера — `human-picked` (инструмент
 * `carry_probe`) и `human-unpicked` (`stray_probe`). Переходник читает их своим `mcpSource`,
 * тест выбирает (`select` — дорога ядра: `sessionMcp` с `mcpPicks`), выбранный уходит шагу и
 * вызывается моделью, невыбранный не стартует — хотя лежит там, где CLI искал бы его сам.
 */

export const HUMAN_PICKED = 'human-picked';
export const HUMAN_UNPICKED = 'human-unpicked';
export type HumanCli = 'codex' | 'goose' | 'opencode' | 'kimi';

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const q = (s: string): string => JSON.stringify(s);

/** Посадить оба сервера в конфиг MCP человека у CLI `cli`. */
export function plantHuman(live: LiveRoot, cli: HumanCli): void {
  const logs = carryLogs(live);
  const servers: [string, string, string][] = [
    [HUMAN_PICKED, logs.carried, CARRY_TOOL],
    [HUMAN_UNPICKED, logs.stray, STRAY_TOOL],
  ];
  const command = process.execPath;
  if (cli === 'codex') {
    const toml = servers.flatMap(([id, log, tool]) => [
      `[mcp_servers.${id}]`,
      `command = ${q(command)}`,
      `args = [${q(PROBE_SERVER)}]`,
      `env = { PROBE_LOG = ${q(log)}, PROBE_TOOL = ${q(tool)} }`,
    ]);
    put(join(live.home, '.codex', 'config.toml'), `${toml.join('\n')}\n`);
  } else if (cli === 'goose') {
    const yaml = [
      'extensions:',
      ...servers.flatMap(([id, log, tool]) => [
        `  ${id}:`,
        '    enabled: true',
        '    type: stdio',
        `    name: ${id}`,
        `    cmd: ${q(command)}`,
        `    args: [${q(PROBE_SERVER)}]`,
        `    envs: { PROBE_LOG: ${q(log)}, PROBE_TOOL: ${q(tool)} }`,
        '    timeout: 60',
      ]),
      '',
    ].join('\n');
    put(join(live.home, '.config', 'goose', 'config.yaml'), yaml);
    put(join(live.home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml'), yaml);
  } else if (cli === 'opencode') {
    const mcp = Object.fromEntries(
      servers.map(([id, log, tool]) => [
        id,
        {
          type: 'local',
          command: [command, PROBE_SERVER],
          environment: { PROBE_LOG: log, PROBE_TOOL: tool },
        },
      ]),
    );
    put(join(live.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp }));
  } else {
    const mcpServers = Object.fromEntries(
      servers.map(([id, log, tool]) => [
        id,
        { command, args: [PROBE_SERVER], env: { PROBE_LOG: log, PROBE_TOOL: tool } },
      ]),
    );
    put(join(live.home, '.kimi-code', 'mcp.json'), JSON.stringify({ mcpServers }));
  }
}

export interface HumanRunInput extends CarryRunInput {
  cli: HumanCli;
  /** Выбор дороги: прочитанные предложения → серверы шага. */
  select: (source: McpSourceRead) => Record<string, McpServerEntry>;
}

export interface HumanRunResult extends CarryRunResult {
  offered: string[];
  selected: string[];
}

export async function runHumanCarry(input: HumanRunInput): Promise<HumanRunResult> {
  plantHuman(input.live, input.cli);
  const read = input.adapter.mcpSource?.({ pin: livePin(input.live), cwd: input.live.cwd });
  if (!read) throw new Error(`${input.cli}: adapter has no mcpSource`);
  const human = input.select(read);
  const { requests, select: _select, cli: _cli, ...rest } = input;
  const logs = carryLogs(input.live);
  const got = await runP81Mode({
    ...rest,
    index: 0,
    mode: {
      name: 'human mcp',
      over: () => ({ mcpServers: human }),
      hook: 'core',
      answer: 'all',
    },
  });
  const tools = requests.flatMap(requestTools);
  const probe = readProbe(logs.carried);
  return {
    got,
    offered: read.servers.filter((s) => s.entry).map((s) => s.id),
    selected: Object.keys(human),
    calls: probe.filter((e) => e.event === 'call'),
    strays: readProbe(logs.stray),
    tools,
    diag: `${got.seen.map((e) => e.type).join(',')} offered=${JSON.stringify(read)} tools=${tools} probe=${JSON.stringify(probe)}`,
  };
}

/** Оба предложены, выбран один — он и дошёл; невыбранный не стартовал. */
export function expectHumanOffered(r: HumanRunResult): void {
  expect(r.offered.sort(), r.diag).toEqual([HUMAN_PICKED, HUMAN_UNPICKED]);
  expect(r.selected, r.diag).toEqual([HUMAN_PICKED]);
}
