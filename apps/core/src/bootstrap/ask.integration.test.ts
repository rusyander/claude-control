import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { stopSession } from '../adapters/launcher/session-io.ts';
import { liveRoot, livePin } from '../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
} from '../adapters/conformance/__fixtures__/replay.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../journal/read-lines.ts';
import type { LiveTask } from '../journal/resume.ts';
import { newId } from '../lib/ids/uuidv7.ts';
import { scratchDirOf } from '../platform/scratch.ts';
import { hasCli } from '../stub-tasks/__fixtures__/e2e/stand.ts';
import { bootCore, type BootedCore, type BootOptions } from './boot.ts';
import { sessionDirOf } from './conductor-wiring/session-start.ts';
import { roadStart, roadTask } from './__fixtures__/road-start.ts';

/**
 * Вопрос «ask» на НАСТОЯЩЕЙ загрузке ядра (этап 10, F2): `POST /v1/ask` с доказательством
 * человека → задача `ask@1` → исполнитель открывает сессию дорогой ядра во временном каталоге,
 * без инструментов (`--tools ToolSearch`), с единственным лишним сервером MCP — мостом панели,
 * в окружении которого адрес панели и токен ЭТОЙ сессии.
 *
 * Два прогона. Запись живого Claude (`basic`) — форма запуска: каталог, argv, бриф, запись моста,
 * мост, поднятый как его поднял бы CLI, доносит вызов до подставной панели заголовком моста, без
 * ключа панели; дорога без токена в книге отказывает. Настоящий `claude` над маршрутом-заглушкой
 * (`packages/stub-model`) — конец хода: запись не может назвать ход ядра (её `command_uuid` чужой),
 * а настоящий CLI называет — шаг `ask-answered`, задача `done`, каталог снят, токена в книге нет.
 * Настоящий `~/.claude` не читается и не пишется (одноразовый дом CLI).
 */

// Мост панели — `tools/mcp/panel.mjs` репозитория (MCP SDK из зависимостей `apps/server`,
// `brand.mjs` сервера); копия набора в Linux-контейнере несёт его (`tools/core-linux.mjs`
// PANEL_ENTRIES) — мост идёт на обеих ОС.

const cores: BootedCore[] = [];
const sessionDirs: string[] = [];
const servers: Server[] = [];
// Уборка независимых ядер и деревьев — разом, а не по очереди: остановка дерева на Windows
// подтверждается поиском метки окружения (секунды под нагрузкой), и сумма четырёх ядер и трёх
// сессий выходила за 20 с `hookTimeout` полного прогона (g13 p10). Срок — как у живых файлов.
afterAll(async () => {
  await Promise.all(cores.map((core) => core.stop().catch(() => undefined)));
  await Promise.all(sessionDirs.map((dir) => stopSession(dir, 'tree').catch(() => undefined)));
  for (const s of servers) s.close();
}, 60_000);

async function until<T>(
  probe: () => T | undefined,
  what: string | (() => string),
  ms = 90_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    // Причина читается в момент срока: хвост журнала тогда, а не на входе ожидания.
    if (Date.now() > deadline) {
      throw new Error(`timeout: ${typeof what === 'string' ? what : what()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const lines = (t: LiveTask): JournalLine[] => readJournalLines(t.dir, t.taskId).lines;

/** Хвост журнала задачи и заметки ядра о ней — в сообщение падения. */
const tailOf = (core: BootedCore, task: LiveTask) => (): string =>
  `journal:\n${lines(task)
    .slice(-14)
    .map((l) => `${l.kind} ${JSON.stringify(l.data).slice(0, 220)}`)
    .join('\n')}\ncore:\n${readFileSync(join(core.layout.logs, 'core.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes(task.taskId) && !l.includes('"route.'))
    .slice(-12)
    .map((l) => l.slice(0, 300))
    .join('\n')}`;

interface PanelHit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Подставная панель: реестр из одного действия чтения и исход `done` на его вызов. */
async function stubPanel(): Promise<{ url: string; hits: PanelHit[] }> {
  const hits: PanelHit[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/api/agent/actions') {
        res.end(
          JSON.stringify({
            actions: [
              {
                name: 'list_rules',
                risk: 'read',
                description: 'List rules',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          }),
        );
        return;
      }
      res.end(JSON.stringify({ outcome: 'done', result: 'three rules' }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  // Порты панели и ядра (5170–5180) заглушке запрещены: живой стенд рядом не задевается.
  expect(port < 5170 || port > 5180).toBe(true);
  return { url: `http://127.0.0.1:${port}`, hits };
}

interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Мост так, как его поднял бы CLI: команда и окружение записи `mcpServers`, JSON-RPC по stdio. */
async function callBridge(entry: McpEntry): Promise<{ list: unknown; call: unknown }> {
  const child = spawn(entry.command, entry.args, {
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...entry.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
  child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
  const send = (m: object): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
  const answer = (id: number): Promise<unknown> =>
    until(
      () => {
        for (const l of out.split('\n')) {
          if (!l.trim()) continue;
          const m = JSON.parse(l) as { id?: number; result?: unknown; error?: unknown };
          if (m.id === id) return m.result ?? { error: m.error };
        }
        return undefined;
      },
      () => `bridge answer ${id}; stderr: ${err}`,
      30_000,
    );
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ask-test', version: '1' },
      },
    });
    await answer(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const list = await answer(2);
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_rules', arguments: {} },
    });
    const call = await answer(3);
    return { list, call };
  } finally {
    child.kill();
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** Вопрос настоящей ручкой `/v1/ask` с числом загрузки страницы (доказательство человека). */
async function ask(
  core: BootedCore,
  fields: Record<string, unknown>,
): Promise<{ status: number; reply: { taskId?: string } }> {
  const coreToken = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${coreToken}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/ask`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ cmdId: newId(), fields, proof: { nonce, page } }),
  });
  return { status: res.status, reply: (await res.json()) as { taskId?: string } };
}

const loginPath: BootOptions['loginPath'] = async () => ({
  path: process.env.PATH ?? '',
  source: 'known-dirs',
  reason: 'test login path',
});

const sameDir = (a: string, b: string): boolean =>
  realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();

/** Токен — только в записи запуска моста; журнал задачи, состояние, логи ядра его не видят. */
function tokenHolders(core: BootedCore, task: LiveTask, token: string): string[] {
  return [...filesUnder(task.dir), ...filesUnder(core.layout.logs)]
    .filter((f) => readFileSync(f, 'utf8').includes(token))
    .map((f) => relative(task.dir, f).replace(/\\/g, '/'));
}

const present = hasCli(claudeRunFacts.binary.command);
/** PNG 1×1 (70 байт): картинка вопроса. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('core ask road through the real boot (stage 10 F2)', () => {
  it('replayed claude: POST /v1/ask → scratch cwd, --tools ToolSearch, the question on stdin, panel-bridge the only extra MCP server with this session token; the bridge reaches the panel by its header, no panel key; the token stays out of the journal; a road start without a booked token is refused', async () => {
    const home = join(tempDir('ask-boot-'), 'core');
    const live = liveRoot('ask-boot-');
    const bin = join(live.root, 'bin');
    mkdirSync(bin, { recursive: true });
    installReplay(bin, claudeRunFacts.binary.command);
    const dump = join(live.root, 'dump.json');
    const core = await bootCore({
      home,
      build: 'ask-test',
      loginPath,
      loop: {
        pin: () => ({
          ...livePin(live, replayEnv({ fixture: fixturePath('claude', 'basic'), dump })),
          REPLAY_MAX_MS: '150000',
        }),
        pathPrefix: [bin, dirname(process.execPath)],
        sweepMs: 100,
      },
    });
    cores.push(core);
    const panel = await stubPanel();
    const bridgeToken = randomBytes(32).toString('base64url');
    const prompt = 'Сколько правил в слое? Ответь числом.';
    const { status, reply } = await ask(core, {
      title: 'вопрос агента панели',
      prompt,
      tools: 'panel-bridge',
      panelBridge: { url: panel.url, token: bridgeToken, conversation: 'conv-ask' },
    });
    expect(status, JSON.stringify(reply)).toBe(202);
    const task = core.registry.live(reply.taskId!)!;
    expect(core.askBridges.get(task.taskId)).toBe(bridgeToken);

    const started = await until(
      () => lines(task).find((l) => l.kind === 'session.started'),
      tailOf(core, task),
    );
    const sessionDir = sessionDirOf(task, started.sessionId!);
    sessionDirs.push(sessionDir);
    const data = started.data as { cwd: string; argv: string[] };
    // Временный каталог ядра (сравнение по настоящему пути: TEMP бывает короткой формой 8.3).
    expect(sameDir(data.cwd, scratchDirOf(task.taskId))).toBe(true);
    // Без инструментов: CLI видит только поиск инструментов MCP.
    expect(data.argv[data.argv.indexOf('--tools') + 1]).toBe('ToolSearch');

    const got = await until(() => {
      const d = readDump(dump);
      return d && d.stdin.some((m) => m.type === 'user') ? d : undefined;
    }, 'question delivered to the CLI');
    expect(sameDir(got.cwd, scratchDirOf(task.taskId))).toBe(true);
    expect(JSON.stringify(got.stdin)).toContain(prompt);
    // Токен моста — не в окружении CLI: только в записи моста.
    expect(JSON.stringify(got.env)).not.toContain(bridgeToken);

    const mcp = JSON.parse(readFileSync(join(sessionDir, 'claude', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, McpEntry>;
    };
    // Агенту панели — только руки панели (s10 p8): своего сервера ядра нет, сервер права есть.
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['agentdeck-permit', 'panel-bridge']);
    const bridge = mcp.mcpServers['panel-bridge']!;
    expect(bridge.args[0]!.replace(/\\/g, '/')).toMatch(/\/tools\/mcp\/panel\.mjs$/);
    expect(bridge.args.slice(1)).toEqual(['--conversation', 'conv-ask']);
    expect(bridge.env).toEqual({ AGENTDECK_URL: panel.url, AGENTDECK_BRIDGE_TOKEN: bridgeToken });
    // Токен ядра мосту не положен: его окружение — только адрес панели и токен моста.
    for (const [name, entry] of Object.entries(mcp.mcpServers)) {
      if (name !== 'panel-bridge') expect(JSON.stringify(entry)).not.toContain(bridgeToken);
    }

    // Вызов инструмента моста доходит до панели: заголовок моста, ключа панели нет.
    const bridged = await callBridge(bridge);
    expect(JSON.stringify(bridged.list)).toContain('list_rules');
    expect(JSON.stringify(bridged.call)).toContain('three rules');
    const call = panel.hits.find((h) => h.url === '/api/agent/actions/list_rules');
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-agentdeck-bridge-token']).toBe(bridgeToken);
    expect(call?.headers.authorization).toBeUndefined();
    expect(JSON.parse(call!.body)).toEqual({ input: {}, conversationId: 'conv-ask' });

    expect(tokenHolders(core, task, bridgeToken)).toEqual([
      `${relative(task.dir, sessionDir).replace(/\\/g, '/')}/claude/mcp.json`,
    ]);

    // Токена в книге нет (не та задача, конец задачи, перезапуск ядра) — дорога моста не даёт.
    const other = await roadTask(core, claudeRunFacts.id);
    const start = roadStart({
      live,
      bin,
      task: other,
      adapterId: claudeRunFacts.id,
      fixture: fixturePath(claudeRunFacts.id, 'basic'),
      dump: join(live.root, `dump-${newId()}.json`),
    });
    const refused = await core.road.prepare({ ...start, ask: { bridge: { url: panel.url } } });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/panel-bridge token unknown/);
  }, 240_000);

  it.skipIf(!present)(
    'real claude over a stub route chosen in the ask: the turn end closes the step ask-answered, the task is done, the scratch dir removed and the bridge token dropped; the model saw the question and no built-in tools',
    async () => {
      const home = join(tempDir('ask-live-'), 'core');
      const live = liveRoot('ask-live-');
      const trace = join(live.root, 'stub-trace.jsonl');
      const core = await bootCore({
        home,
        build: 'ask-live',
        loginPath,
        routeConfig: {
          stub: [{ name: 'ask', script: Array(8).fill('Три правила.') as string[], trace }],
        },
        loop: { pin: () => livePin(live), sweepMs: 100 },
      });
      cores.push(core);
      const panel = await stubPanel();
      const bridgeToken = randomBytes(32).toString('base64url');
      const prompt = 'Сколько правил в слое? Ответь числом.';
      const { status, reply } = await ask(core, {
        title: 'вопрос агента панели',
        prompt,
        tools: 'panel-bridge',
        panelBridge: { url: panel.url, token: bridgeToken },
        adapter: claudeRunFacts.id,
        routes: [
          {
            adapter: claudeRunFacts.id,
            route: { kind: 'stub', id: 'stub:ask' },
            modelPattern: '*',
          },
        ],
        model: 'stub-model',
      });
      expect(status, JSON.stringify(reply)).toBe(202);
      const task = core.registry.live(reply.taskId!)!;
      expect(task.state.created?.allowedRoutes.map((r) => r.route.id)).toEqual(['stub:ask']);

      const started = await until(
        () => lines(task).find((l) => l.kind === 'session.started'),
        tailOf(core, task),
      );
      sessionDirs.push(sessionDirOf(task, started.sessionId!));
      expect((started.data as { route: { id: string } }).route.id).toBe('stub:ask');

      await until(
        () => (task.state.task === 'done' ? true : undefined),
        tailOf(core, task),
        150_000,
      );
      const ended = lines(task).find((l) => l.kind === 'step.ended');
      expect((ended?.data as { reason?: string }).reason).toBe('ask-answered');
      expect(task.state.ended).toBe('done');
      await until(
        () => (existsSync(scratchDirOf(task.taskId)) ? undefined : true),
        () =>
          `scratch dir removed at task end: ${JSON.stringify(
            lines(task)
              .filter(
                (l) =>
                  l.kind.startsWith('resource.') ||
                  l.kind.startsWith('session.') ||
                  l.kind.startsWith('step.') ||
                  l.kind === 'task.ended',
              )
              .map((l) => [l.at, l.kind, l.data]),
          )}`,
        30_000,
      );
      expect(core.askBridges.get(task.taskId)).toBeUndefined();
      // Конец задачи снимает и всё прочее `task-end`: сервер маршрута-заглушки и временный
      // каталог сессии — снято и прочитано назад, ни одной строки живой или утёкшей.
      await until(
        () =>
          Object.values(task.state.resources).every((r) => r.status === 'verified')
            ? true
            : undefined,
        () => `every task-end resource verified: ${JSON.stringify(task.state.resources)}`,
        30_000,
      );
      expect(
        Object.values(task.state.resources)
          .map((r) => r.kind)
          .sort(),
      ).toEqual(['stub-server', 'tmpdir', 'tmpdir']);

      // Модель получила вопрос, и ни одного встроенного инструмента CLI.
      const requests = readFileSync(trace, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as { kind: string; body: { tools?: { name: string }[] } })
        .filter((r) => r.kind === 'model');
      const asked = requests.find((r) => JSON.stringify(r.body).includes(prompt));
      expect(asked, `${requests.length} model requests`).toBeDefined();
      const tools = (asked!.body.tools ?? []).map((t) => t.name);
      for (const builtin of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch']) {
        expect(tools).not.toContain(builtin);
      }
      expect(
        tokenHolders(core, task, bridgeToken).every((p) => p.endsWith('claude/mcp.json')),
      ).toBe(true);
    },
    240_000,
  );

  it.skipIf(!present)(
    'real claude, an ask with an image (tools none): the image file lands in the task dir, the journal names it without bytes, the model request carries it as an image block next to the question',
    async () => {
      const home = join(tempDir('ask-img-'), 'core');
      const live = liveRoot('ask-img-');
      const trace = join(live.root, 'stub-trace.jsonl');
      const core = await bootCore({
        home,
        build: 'ask-img',
        loginPath,
        routeConfig: {
          stub: [{ name: 'ask', script: Array(8).fill('Квадрат.') as string[], trace }],
        },
        loop: { pin: () => livePin(live), sweepMs: 100 },
      });
      cores.push(core);
      const prompt = 'Что на картинке? Одно слово.';
      const { status, reply } = await ask(core, {
        title: 'вопрос с картинкой',
        prompt,
        tools: 'none',
        images: [{ name: 'снимок экрана.png', mediaType: 'image/png', base64: PNG_1PX }],
        adapter: claudeRunFacts.id,
        routes: [
          {
            adapter: claudeRunFacts.id,
            route: { kind: 'stub', id: 'stub:ask' },
            modelPattern: '*',
          },
        ],
        model: 'stub-model',
      });
      expect(status, JSON.stringify(reply)).toBe(202);
      const task = core.registry.live(reply.taskId!)!;
      expect(task.state.created?.ask?.images).toEqual([
        { name: 'снимок экрана.png', mediaType: 'image/png', file: 'ask-images/0.png', bytes: 70 },
      ]);
      expect(readFileSync(join(task.dir, 'ask-images/0.png')).toString('base64')).toBe(PNG_1PX);
      // Содержимого картинки в журнале нет — только имя, тип, файл и размер.
      expect(lines(task).some((l) => JSON.stringify(l).includes(PNG_1PX))).toBe(false);

      const started = await until(
        () => lines(task).find((l) => l.kind === 'session.started'),
        tailOf(core, task),
      );
      sessionDirs.push(sessionDirOf(task, started.sessionId!));
      await until(
        () => (task.state.task === 'done' ? true : undefined),
        tailOf(core, task),
        150_000,
      );
      const requests = readFileSync(trace, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map(
          (l) =>
            JSON.parse(l) as {
              kind: string;
              body: { messages?: { role: string; content: unknown }[] };
            },
        )
        .filter((r) => r.kind === 'model');
      const asked = requests.find((r) => JSON.stringify(r.body).includes(prompt));
      expect(asked, `${requests.length} model requests`).toBeDefined();
      const user = asked!.body.messages!.find(
        (m) => m.role === 'user' && JSON.stringify(m.content).includes(prompt),
      )!;
      expect(user.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
          }),
        ]),
      );
    },
    240_000,
  );

  it('an image whose bytes are not its declared type is refused 422 before any task; a CLI without image support is refused by the road with a named reason', async () => {
    const home = join(tempDir('ask-img-bad-'), 'core');
    const core = await bootCore({ home, build: 'ask-img-bad', loginPath });
    cores.push(core);
    const before = core.registry.list().length;
    const { status, reply } = await ask(core, {
      title: 'чужой тип',
      prompt: 'что это?',
      tools: 'none',
      images: [{ name: 'a.jpg', mediaType: 'image/jpeg', base64: PNG_1PX }],
    });
    expect(status).toBe(422);
    expect(JSON.stringify(reply)).toContain('images[0]: bytes are image/png, declared image/jpeg');
    expect(core.registry.list().length).toBe(before);

    // Переходник без `caps.images` (qwen: подача картинок не доказана) — отказ дороги до запуска.
    const live = liveRoot('ask-img-bad-');
    const bin = join(live.root, 'bin');
    mkdirSync(bin, { recursive: true });
    const task = await roadTask(core, 'qwen');
    const start = roadStart({
      live,
      bin,
      task,
      adapterId: 'qwen',
      fixture: fixturePath('qwen', 'basic'),
      dump: join(live.root, 'dump.json'),
    });
    const refused = await core.road.prepare({ ...start, ask: { bridge: null, images: 1 } });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toBe(
      'images-unsupported: adapter qwen does not take images',
    );
  });
});
