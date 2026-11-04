import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geminiRunFacts } from '@agentdeck/providers/gemini';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import { liveRoot, type LiveRoot } from '../conformance/__fixtures__/live.ts';

/**
 * Почему у Gemini нет MCP шага (s10 p7) — доказательство, которое переснимается с каждой версией CLI.
 * Задумка «доверенная папка + системные настройки сеанса прибивают ключи репозитория» не держит:
 * файл `GEMINI_CLI_SYSTEM_SETTINGS_PATH` в каталоге сеанса (владелец — пользователь ядра) Gemini
 * ПРОПУСКАЕТ, а доверенная папка тут же исполняет `tools.discoveryCommand` репозитория — уже на
 * `initialize`. Недоверенная копия (как запускает переходник) ту же команду не исполняет.
 * Покраснел первый случай — Gemini сменил правило: пересмотреть потерю в `gemini.ts` `planGemini`.
 */

const present = hasCli(geminiRunFacts.binary.command);
let live: LiveRoot;

beforeAll(() => {
  if (present) live = liveRoot('gemini-trust-');
});

afterAll(() => {
  if (live) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
});

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `gemini --acp` до ответа на `initialize`; репозиторий несёт команду обнаружения с меткой. */
async function initialize(trust: boolean, tag: string): Promise<{ stderr: string; ran: boolean }> {
  const root = join(live.root, tag);
  const cwd = join(root, 'repo');
  const marker = join(root, 'discovery.log');
  const mark = join(root, 'mark.cjs');
  put(
    mark,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');console.log('[]');`,
  );
  put(
    join(cwd, '.gemini', 'settings.json'),
    JSON.stringify({
      tools: { discoveryCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(mark)}` },
    }),
  );
  const system = join(root, 'session', 'gemini-system', 'settings.json');
  put(system, JSON.stringify({ tools: { discoveryCommand: '' }, mcp: { allowed: ['x'] } }));
  const home = join(root, 'session', 'gemini-home');
  put(
    join(home, '.gemini', 'settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
  );
  const child = spawn(geminiRunFacts.binary.command, ['--acp'], {
    cwd,
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {
      ...process.env,
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_TRUST_WORKSPACE: trust ? 'true' : 'false',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: system,
      GEMINI_API_KEY: 'stub-key',
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })}\n`,
  );
  const deadline = Date.now() + 60_000;
  while (!stdout.includes('"id":1') && Date.now() < deadline && child.exitCode === null)
    await new Promise((r) => setTimeout(r, 100));
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
  return { stderr, ran: existsSync(marker) };
}

/**
 * Сетевой сервер MCP из ACP `session/new` (s10 p11): Gemini 0.66 кладёт его в настройки сеанса, но
 * `McpClientManager.startConfiguredMcpServers` в недоверенной папке выходит сразу, до выбора
 * транспорта, — значит, не переносится и сетевой, не только stdio. Слушатель на петле считает
 * запросы; доверенный запуск — контроль, что проба вообще умеет покраснеть.
 */
async function remoteMcpHits(trust: boolean, tag: string): Promise<{ hits: number; log: string }> {
  const root = join(live.root, tag);
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  const home = join(root, 'session', 'gemini-home');
  put(
    join(home, '.gemini', 'settings.json'),
    JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
  );
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const child = spawn(geminiRunFacts.binary.command, ['--acp'], {
    cwd,
    shell: process.platform === 'win32',
    windowsHide: true,
    env: {
      ...process.env,
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_TRUST_WORKSPACE: trust ? 'true' : 'false',
      GEMINI_API_KEY: 'stub-key',
      GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:9',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const send = (id: number, method: string, params: unknown) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const until = async (needle: string, ms: number) => {
    const deadline = Date.now() + ms;
    while (!stdout.includes(needle) && Date.now() < deadline && child.exitCode === null)
      await new Promise((r) => setTimeout(r, 100));
  };
  try {
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
    await until('"id":1', 60_000);
    send(2, 'session/new', {
      cwd,
      mcpServers: [
        { type: 'http', name: 'probe', url: `http://127.0.0.1:${port}/mcp`, headers: [] },
      ],
    });
    await until('"id":2', 60_000);
    // Обнаружение MCP идёт фоном после ответа: время на первый запрос клиента.
    const settle = Date.now() + 15_000;
    while (hits === 0 && Date.now() < settle) await new Promise((r) => setTimeout(r, 200));
  } finally {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    server.close();
  }
  return { hits, log: `${stdout.slice(-1500)}\n${stderr.slice(-1500)}` };
}

describe.skipIf(!present)('gemini: a remote MCP server from ACP session/new (s10 p11)', () => {
  it('trusted (control): the CLI reaches the loopback MCP server', async () => {
    const got = await remoteMcpHits(true, 'remote-trusted');
    expect(got.hits, got.log).toBeGreaterThan(0);
  }, 120_000);

  it('untrusted (how the adapter launches): the remote MCP server gets no request', async () => {
    const got = await remoteMcpHits(false, 'remote-untrusted');
    expect(got.hits, got.log).toBe(0);
  }, 120_000);
});

describe.skipIf(!present)(
  'gemini: a trusted folder cannot be pinned by session system settings',
  () => {
    it('trusted: the session system settings file is skipped and the repo discovery command runs', async () => {
      const got = await initialize(true, 'trusted');
      expect(got.stderr).toMatch(/Skipping system settings file/);
      expect(got.ran, got.stderr.slice(-2000)).toBe(true);
    }, 90_000);

    it('untrusted (how the adapter launches): the repo discovery command never runs', async () => {
      const got = await initialize(false, 'untrusted');
      expect(got.ran, got.stderr.slice(-2000)).toBe(false);
    }, 90_000);
  },
);
