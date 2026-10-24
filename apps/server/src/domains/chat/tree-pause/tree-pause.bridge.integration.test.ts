import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { ChatRunRegistry } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { RunOptions } from '../ChatRunner/ChatRunner.ts';
import { RunLedger } from '../run-ledger/run-ledger.ts';
import { TreePause } from './tree-pause.ts';

/**
 * Мост прав разговора, продолженного «Продолжить всё» после перезапуска панели.
 *
 * Было: подхваченная из журнала сессия несёт мост с пустым адресом
 * (`run-reattach.ts` — ход, начатый CLI после подхвата, ключ берёт из файла).
 * Пауза дерева сохраняла эти параметры как есть, продолжение запускало с ними
 * новый процесс — и каждый запрос прав в продолженной группе получал отказ
 * «no connection to the AgentDeck panel», до человека не доходя.
 *
 * Путь настоящий: первая жизнь панели (реестр, посредник, процесс) → выход
 * сервера (`detachAll`) → вторая жизнь усыновляет сессию из журнала → пауза
 * дерева → «Продолжить всё» → настоящий `ChatRun` пишет `--mcp-config` → тот
 * самый сервер прав (`permission-prompt-server.mjs`), которого поднял бы CLI, получает
 * запрос. Подменены только CLI (`fake-live-cli.mjs`; его роль «поднять MCP из
 * конфига и спросить» играет тест) и HTTP панели — заглушка на настоящем сокете.
 */

const FAKE = fileURLToPath(new URL('../__fixtures__/fake-live-cli.mjs', import.meta.url));
const PERMISSION_SERVER = fileURLToPath(
  new URL('../permission-prompt-server.mjs', import.meta.url),
);
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const PARENT = 'родитель';
const CHAT = 'chat-0';

let root: string;
let panel: Server | undefined;
const registries: ChatRunRegistry[] = [];
const spawned: ChildProcess[] = [];
const savedPath = process.env.PATH;

beforeAll(() => {
  if (process.platform !== 'win32') chmodSync(FAKE, 0o755);
});

afterEach(async () => {
  delete process.env.FAKE_ARGV_DUMP;
  process.env.PATH = savedPath;
  for (const registry of registries.splice(0)) {
    registry.stopAll();
    registry.livePool.closeAll();
  }
  for (const child of spawned.splice(0)) child.kill();
  await new Promise<void>((done) => (panel ? panel.close(() => done()) : done()));
  panel = undefined;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* папку держит умирающий процесс */
  }
});

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** `claude` (или `claude.cmd`) в начале PATH — заглушка, которую поднимет продолжение. */
function putFakeClaudeOnPath(bin: string): void {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
  } else {
    const shim = join(bin, 'claude');
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
}

/** HTTP панели: запросы прав, дошедшие до неё, — и «разрешить» на каждый. */
async function startPanel(): Promise<{ url: string; asks: { runId?: string }[] }> {
  const asks: { runId?: string }[] = [];
  panel = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      if (req.url === '/api/chat/permission-request') asks.push(JSON.parse(body) as never);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow' }));
    });
  });
  await new Promise<void>((done) => panel!.listen(0, '127.0.0.1', () => done()));
  return { url: `http://127.0.0.1:${(panel!.address() as AddressInfo).port}`, asks };
}

/** То, что сделал бы CLI: поднять сервер прав из своего `--mcp-config` и спросить. */
async function askThroughBridge(argv: string[]): Promise<{ behavior: string; message?: string }> {
  const at = argv.indexOf('--mcp-config');
  expect(at).toBeGreaterThanOrEqual(0);
  const config = JSON.parse(readFileSync(argv[at + 1] ?? '', 'utf8')) as {
    mcpServers: Record<string, { env: Record<string, string> }>;
  };
  const env = config.mcpServers['perm-guard']?.env ?? {};
  const child = spawn(process.execPath, [PERMISSION_SERVER], {
    env: { ...process.env, ...env, PERM_PROGRESS_MS: '0' },
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  spawned.push(child);
  const reply = new Promise<{ behavior: string; message?: string }>((done) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        result?: { content?: { text: string }[] };
      };
      if (message.id === 2) done(JSON.parse(message.result?.content?.[0]?.text ?? '{}') as never);
    });
  });
  const send = (message: object) => child.stdin!.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'approve',
      arguments: { tool_name: 'Bash', input: { command: 'git push' }, tool_use_id: 'tu-1' },
    },
  });
  return reply;
}

describe(
  '«Продолжить всё» после перезапуска панели — мост прав к этой панели',
  { timeout: 60_000 },
  () => {
    it('сессия подхвачена из журнала, дерево на паузе и продолжено — запрос прав доходит до панели', async () => {
      root = mkdtempSync(join(tmpdir(), 'cc-tree-bridge-'));
      const appData = join(root, 'agentdeck');
      const copy = join(root, 'copy-0');
      const hang = join(root, 'hang-pid');
      const dump = join(root, 'argv.jsonl');
      const tokenFile = join(root, 'api-token');
      mkdirSync(appData, { recursive: true });
      mkdirSync(copy, { recursive: true });
      writeFileSync(tokenFile, 'test-token');
      process.env.FAKE_ARGV_DUMP = dump;
      // Журнал не хранит команду — продолжение запускает CLI по умолчанию из PATH,
      // как в жизни; здесь под этим именем лежит заглушка.
      putFakeClaudeOnPath(join(root, 'bin'));
      const { url, asks } = await startPanel();
      const bridge = (runId: string): NonNullable<RunOptions['permissionPrompt']> => ({
        runId,
        baseUrl: url,
        tokenFile,
      });
      const store = new AppStore(appData);
      store.setChatLink(CHAT, {
        parentChatId: PARENT,
        createdAt: new Date().toISOString(),
        branch: 'feature/one',
        groupIndex: 0,
        stage: 'work',
      });

      // Первая жизнь: ход группы с мостом панели; перезапуск застаёт его посреди хода.
      const first = new ChatRunRegistry();
      registries.push(first);
      const firstLedger = new RunLedger(appData);
      first.setLedger(firstLedger, undefined, (pid) => Promise.resolve(pid));
      first.start(
        CHAT,
        { prompt: `HANG ${hang}`, cwd: copy, command: COMMAND, permissionPrompt: bridge(CHAT) },
        {},
      );
      await waitFor(() => existsSync(hang));
      await waitFor(() => Boolean(firstLedger.read()[0]?.sessionId));
      first.detachAll();

      // Вторая жизнь: та же сессия подхвачена из журнала, как при старте сервера.
      const second = new ChatRunRegistry();
      registries.push(second);
      const ledger = new RunLedger(appData);
      second.setLedger(ledger, undefined, (pid) => Promise.resolve(pid));
      const entries = ledger.read();
      expect(entries).toEqual([
        expect.objectContaining({
          key: CHAT,
          relay: expect.objectContaining({ runIdFile: expect.any(String) }),
        }),
      ]);
      for (const entry of entries) expect(second.adopt(entry)).toBe(true);

      // Пауза и продолжение дерева — тем же связыванием, что в runtime.
      const tree = new TreePause({
        links: () => store.getChatLinks(),
        runs: second,
        store: {
          get: (key) => store.getTreePause(key),
          all: () => store.getTreePauses(),
          set: (record) => store.setTreePause(record),
          clear: (key) => store.clearTreePause(key),
        },
        idle: {
          snapshot: (chatId) => second.idleWithBackground(chatId),
          close: (chatId) => second.closeLive(chatId),
        },
        bridge,
      });
      expect(tree.pause(PARENT)).toMatchObject({ stopped: 1, unconfirmed: 0 });
      expect(tree.resume(PARENT)).toMatchObject({ resumed: 1 });

      await waitFor(
        () => existsSync(dump) && readFileSync(dump, 'utf8').trim().split('\n').length >= 2,
      );
      const argvs = readFileSync(dump, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const decision = await askThroughBridge(argvs.at(-1) ?? []);

      expect(decision).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
      expect(asks).toEqual([expect.objectContaining({ runId: CHAT, toolName: 'Bash' })]);
    });
  },
);
