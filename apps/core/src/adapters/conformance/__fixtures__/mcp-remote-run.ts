import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import type { McpServerEntry } from '../../adapter.types.ts';
import { mcpSecretValues } from '../../mcp-carry.ts';
import type { McpSourceRead } from '../../mcp-source/mcp-source.ts';
import { livePin, type LiveRoot } from './live.ts';
import {
  CARRY_TOOL,
  carryLogs,
  MCP_DONE,
  readProbe,
  requestTools,
  type CarryRunInput,
  type ProbeEntry,
} from './mcp-carry-run.ts';
import { startHttpProbe } from './mcp-http-probe-server.mjs';
import { P81_ATTRIBUTION, runP81Mode, type P81Result } from './p81-run.ts';

/**
 * УДАЛЁННЫЙ сервер MCP человека (streamable HTTP) на настоящем CLI (s10 p9): в конфиг MCP самого
 * CLI посажен `human-remote` с адресом подставного сервера (`mcp-http-probe-server.mjs`, loopback)
 * и двумя заголовками — один буквой конфига, второй из переменной окружения задачи (пин). Читатель
 * CLI (`mcpSource`) подставляет значения, выбор дороги отдаёт сервер шагу, CLI сеанса подключается и
 * модель вызывает инструмент. Сервер сверяет значения заголовков сам — в журнал только имена и
 * `auth: true|false`; значения — то, что дорога кладёт в книгу ключей (`mcpSecretValues`).
 */

export const REMOTE_SERVER = 'human-remote';
export const REMOTE_TOKEN_VAR = 'PROBE_REMOTE_TOKEN';
const TOKEN = 'remote-token-4b9e2f';
const KEY = 'probe-key-81c7aa';
export const REMOTE_HEADERS = { Authorization: `Bearer ${TOKEN}`, 'X-Probe-Key': KEY };
export type RemoteCli = 'codex' | 'opencode';

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const q = (s: string): string => JSON.stringify(s);

/** Посадить `human-remote` в конфиг MCP человека у CLI `cli` (дом `live.home`). */
export function plantRemote(live: LiveRoot, cli: RemoteCli, url: string): void {
  if (cli === 'codex') {
    put(
      join(live.home, '.codex', 'config.toml'),
      [
        `[mcp_servers.${REMOTE_SERVER}]`,
        `url = ${q(url)}`,
        `http_headers = { "X-Probe-Key" = ${q(KEY)} }`,
        `bearer_token_env_var = ${q(REMOTE_TOKEN_VAR)}`,
        '',
      ].join('\n'),
    );
  } else {
    const mcp = {
      [REMOTE_SERVER]: {
        type: 'remote',
        url,
        headers: { 'X-Probe-Key': KEY, Authorization: `Bearer {env:${REMOTE_TOKEN_VAR}}` },
      },
    };
    put(join(live.home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp }));
  }
}

export interface RemoteRunInput extends CarryRunInput {
  cli: RemoteCli;
  /** Выбор дороги: прочитанные предложения → серверы шага. */
  select: (source: McpSourceRead) => Record<string, McpServerEntry>;
}

/** Строка журнала удалённого сервера: имена заголовков и признак auth, значений нет. */
export interface RpcEntry extends ProbeEntry {
  method?: string;
  headers?: string[];
  auth?: boolean;
}

export interface RemoteRunResult {
  got: P81Result;
  offered: string[];
  /** Значения, которые дорога положила бы в книгу ключей (`mcp:<srv>:<header>`). */
  keyBook: Record<string, string>;
  rpcs: RpcEntry[];
  calls: RpcEntry[];
  /** Сырой журнал сервера: значений заголовков в нём быть не должно. */
  logText: string;
  tools: string[];
  diag: string;
}

export async function runRemoteCarry(input: RemoteRunInput): Promise<RemoteRunResult> {
  const logs = carryLogs(input.live);
  const probe = await startHttpProbe({
    log: logs.carried,
    tool: CARRY_TOOL,
    expectHeaders: REMOTE_HEADERS,
  });
  try {
    plantRemote(input.live, input.cli, probe.url);
    const pin = livePin(input.live, { [REMOTE_TOKEN_VAR]: TOKEN });
    const read = input.adapter.mcpSource?.({ pin, cwd: input.live.cwd });
    if (!read) throw new Error(`${input.cli}: adapter has no mcpSource`);
    const human = input.select(read);
    const { requests, select: _select, cli: _cli, ...rest } = input;
    const got = await runP81Mode({
      ...rest,
      index: 0,
      mode: {
        name: 'remote mcp',
        over: () => ({ mcpServers: human }),
        hook: 'core',
        answer: 'all',
      },
    });
    const entries = readProbe(logs.carried) as RpcEntry[];
    const tools = requests.flatMap(requestTools);
    const remote = human[REMOTE_SERVER];
    return {
      got,
      offered: read.servers.filter((s) => s.entry).map((s) => s.id),
      keyBook: remote ? mcpSecretValues(remote) : {},
      rpcs: entries.filter((e) => e.event === 'rpc'),
      calls: entries.filter((e) => e.event === 'call'),
      logText: readFileSync(logs.carried, 'utf8'),
      tools,
      diag: `${got.seen.map((e) => e.type).join(',')} read=${JSON.stringify(read.servers.map((s) => ({ id: s.id, skipped: s.skipped })))} tools=${tools} probe=${JSON.stringify(entries)}`,
    };
  } finally {
    await probe.close();
  }
}

/**
 * Приговор: сервер предложен и выбран, его заголовки — в книге ключей; CLI подключился, каждый
 * запрос нёс оба заголовка с верными значениями, модель вызвала инструмент ровно раз и закончила
 * текстом; журнал сервера знает только имена заголовков.
 */
export function expectRemoteCarried(r: RemoteRunResult): void {
  expect(r.offered, r.diag).toContain(REMOTE_SERVER);
  expect(r.keyBook, r.diag).toEqual(REMOTE_HEADERS);
  expect(
    r.got.seen.find((e) => e.type === 'turn.ended'),
    r.diag,
  ).toMatchObject({ attribution: P81_ATTRIBUTION, isError: false, text: MCP_DONE });
  expect(
    r.rpcs.map((e) => e.method),
    r.diag,
  ).toEqual(expect.arrayContaining(['initialize', 'tools/list', 'tools/call']));
  expect(
    r.rpcs.every((e) => e.auth === true),
    r.diag,
  ).toBe(true);
  for (const e of r.rpcs)
    expect(e.headers, r.diag).toEqual(expect.arrayContaining(['authorization', 'x-probe-key']));
  expect(r.calls, r.diag).toHaveLength(1);
  expect(r.calls[0]).toMatchObject({ tool: CARRY_TOOL, args: { note: 'carried' }, auth: true });
  for (const value of Object.values(REMOTE_HEADERS))
    expect(r.logText).not.toContain(value.replace('Bearer ', ''));
}
