import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { McpServerEntry } from '../../adapter.types.ts';
import type { LiveRoot } from './live.ts';
import {
  P81_ATTRIBUTION,
  runP81Mode,
  type P81Input,
  type P81Mode,
  type P81Result,
} from './p81-run.ts';

/**
 * Перенос MCP в чужой CLI на настоящем CLI (s10 p6), поверх прогона P81 (`runP81Mode`): шаг несёт
 * сервер `probe-carried` (инструмент `carry_probe`) и запись под именем сервера права
 * `agentdeck-permit` (инструмент `stray_probe`) — её переходник переносить НЕ должен (вопрос о праве
 * идёт строкой протокола). Ещё один `stray_probe` посажен в конфиги MCP человека и репозитория там,
 * где CLI искал бы их без своего дома у сеанса. Модель — stub-model: находит в инструментах запроса
 * `carry_probe` (имя у каждого CLI своё, с приставкой сервера) и вызывает его, затем текст.
 */

export const PROBE_SERVER = fileURLToPath(new URL('./mcp-probe-server.mjs', import.meta.url));
export const CARRIED = 'probe-carried';
export const CARRY_TOOL = 'carry_probe';
export const STRAY_TOOL = 'stray_probe';
export const MCP_DONE = 'MCP_DONE';

export interface CarryLogs {
  carried: string;
  stray: string;
}

export function carryLogs(live: LiveRoot): CarryLogs {
  return {
    carried: join(live.root, 'probe-carried.log'),
    stray: join(live.root, 'probe-stray.log'),
  };
}

const probe = (log: string, tool: string): McpServerEntry => ({
  command: process.execPath,
  args: [PROBE_SERVER],
  env: { PROBE_LOG: log, PROBE_TOOL: tool },
});

/** Режим P81 «перенос MCP»: хук ядра настоящий, на вопросы о праве — «да». */
export function carryMode(logs: CarryLogs): P81Mode {
  return {
    name: 'mcp carriage',
    over: () => ({
      mcpServers: {
        [CARRIED]: probe(logs.carried, CARRY_TOOL),
        'agentdeck-permit': probe(logs.stray, STRAY_TOOL),
      },
    }),
    hook: 'core',
    answer: 'all',
  };
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Посеять `stray_probe` в конфиги MCP человека (дом `live.home`) и репозитория (`live.cwd`). */
export function plantStrays(live: LiveRoot, log: string): void {
  const command = process.execPath;
  const args = [PROBE_SERVER];
  const env = { PROBE_LOG: log, PROBE_TOOL: STRAY_TOOL };
  const claudeShape = JSON.stringify({ mcpServers: { stray: { command, args, env } } });
  const codexToml = [
    '[mcp_servers.stray]',
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `env = { PROBE_LOG = ${JSON.stringify(log)}, PROBE_TOOL = "${STRAY_TOOL}" }`,
    '',
  ].join('\n');
  const opencode = JSON.stringify({
    mcp: { stray: { type: 'local', command: [command, ...args], environment: env, enabled: true } },
  });
  const goose = [
    'extensions:',
    '  stray:',
    '    enabled: true',
    '    type: stdio',
    '    name: stray',
    `    cmd: ${JSON.stringify(command)}`,
    `    args: [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    `    envs: { PROBE_LOG: ${JSON.stringify(log)}, PROBE_TOOL: "${STRAY_TOOL}" }`,
    '    timeout: 60',
    '',
  ].join('\n');
  for (const root of [live.home, live.cwd]) {
    put(join(root, '.mcp.json'), claudeShape);
    put(join(root, '.codex', 'config.toml'), codexToml);
    put(join(root, '.gemini', 'settings.json'), claudeShape);
    put(join(root, '.kimi-code', 'mcp.json'), claudeShape);
    put(join(root, 'opencode.json'), opencode);
  }
  put(join(live.home, '.config', 'opencode', 'opencode.json'), opencode);
  put(join(live.home, '.config', 'goose', 'config.yaml'), goose);
  put(join(live.home, 'AppData', 'Roaming', 'Block', 'goose', 'config', 'config.yaml'), goose);
}

interface ToolLike {
  type?: string;
  name?: string;
  function?: { name?: string };
  functionDeclarations?: { name?: string }[];
  tools?: ToolLike[];
}

export interface ToolRef {
  name: string;
  namespace?: string;
}

/**
 * Инструменты запроса модели: openai-chat `tools[].function.name`, google-genai
 * `tools[].functionDeclarations[].name`, openai-responses `tools[].name`; серверы MCP Codex отдаёт
 * пространством имён (`type: "namespace"`, `name: "mcp__<сервер>"`, инструменты внутри).
 */
export function toolRefs(raw: string): ToolRef[] {
  try {
    const body = JSON.parse(raw) as { tools?: ToolLike[] };
    return (body.tools ?? [])
      .flatMap((t): ToolRef[] => {
        if (t.functionDeclarations)
          return t.functionDeclarations.map((d) => ({ name: d.name ?? '' }));
        if (t.type === 'namespace' && t.name) {
          const namespace = t.name;
          return (t.tools ?? []).map((inner) => ({ name: inner.name ?? '', namespace }));
        }
        return [{ name: t.function?.name ?? t.name ?? '' }];
      })
      .filter((ref) => ref.name !== '');
  } catch {
    return [];
  }
}

/** Имена инструментов запроса; инструмент пространства имён — `<пространство>__<имя>`. */
export function requestTools(raw: string): string[] {
  return toolRefs(raw).map((ref) => (ref.namespace ? `${ref.namespace}__${ref.name}` : ref.name));
}

/** Сценарий модели: вызвать перенесённый инструмент, затем текст. Не нашёл — текст с причиной. */
export function carryScript(requests: string[], toolTurns: (raw: string) => number) {
  return (ctx: { request: { raw: string } }) => {
    requests.push(ctx.request.raw);
    if (toolTurns(ctx.request.raw) > 0) return MCP_DONE;
    const ref = toolRefs(ctx.request.raw).find((r) => r.name.includes(CARRY_TOOL));
    if (!ref) return `NO_CARRIED_TOOL ${requestTools(ctx.request.raw).join(',')}`;
    return {
      tool: {
        name: ref.name,
        ...(ref.namespace ? { namespace: ref.namespace } : {}),
        args: { note: 'carried' },
      },
    };
  };
}

export interface ProbeEntry {
  event: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export function readProbe(log: string): ProbeEntry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProbeEntry);
}

export interface CarryRunInput extends Omit<P81Input, 'mode' | 'index'> {
  requests: string[];
}

export interface CarryRunResult {
  got: P81Result;
  /** Вызовы инструмента перенесённого сервера (из его журнала). */
  calls: ProbeEntry[];
  /** Журнал сервера, которого в сеансе быть не должно: пуст — не стартовал. */
  strays: ProbeEntry[];
  /** Имена инструментов во всех запросах к модели. */
  tools: string[];
  /** Сводка для сообщения проверки: события, инструменты, журнал зонда, строки вывода о MCP. */
  diag: string;
}

/** Прогон «перенос MCP»: посеять чужие серверы, пустить сеанс P81 в режиме переноса, собрать журналы. */
export async function runCarry(input: CarryRunInput): Promise<CarryRunResult> {
  const logs = carryLogs(input.live);
  plantStrays(input.live, logs.stray);
  const { requests, ...rest } = input;
  const got = await runP81Mode({ ...rest, index: 0, mode: carryMode(logs) });
  const tools = requests.flatMap(requestTools);
  const probe = readProbe(logs.carried);
  const mcpLines = got.stdout
    .split('\n')
    .filter((l) => /probe|extension|mcp/i.test(l))
    .join('\n')
    .slice(0, 4000);
  return {
    got,
    calls: probe.filter((e) => e.event === 'call'),
    strays: readProbe(logs.stray),
    tools,
    diag: `${got.seen.map((e) => e.type).join(',')} tools=${tools} probe=${JSON.stringify(probe)} stdout=${mcpLines}`,
  };
}

/**
 * Приговор прогона: ход кончился текстом модели после ответа инструмента, перенесённый сервер
 * вызван ровно раз с аргументами модели, чужой сервер не стартовал и его инструмента модель не видела.
 */
export function expectCarried(r: CarryRunResult): void {
  expect(
    r.got.seen.find((e) => e.type === 'turn.ended'),
    r.diag,
  ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: MCP_DONE });
  expect(r.calls, r.diag).toHaveLength(1);
  expect(r.calls[0]).toMatchObject({ tool: CARRY_TOOL, args: { note: 'carried' } });
  expect(r.strays, 'a non-carried MCP server started').toEqual([]);
  expect(r.tools.some((name) => name.includes(STRAY_TOOL))).toBe(false);
}
