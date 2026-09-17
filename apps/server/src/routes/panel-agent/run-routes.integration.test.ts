import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  PanelActionResult,
  PanelAgentConversation,
  PanelAgentRunEvent,
} from '@agentdeck/contracts/panel-agent';
import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';
import { platformSchema } from '@agentdeck/contracts/platform';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { resetCliLookupCache } from '../../providers/detect.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { buildManagedProfile, PLACEHOLDER_KEY } from '../../domains/platform/apply/profile.ts';
import { lightWindowLayers } from '../../domains/platform/layers.ts';
import { PANEL_AGENT_ENV_ALLOWLIST } from '../../domains/panel-agent/runner.ts';
import { writePlatform, writeToken } from '../../domains/platform/store.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';
import { registerPanelAgentRunRoutes, type PanelAgentRunRouteDeps } from './run-routes.ts';
import { PANEL_AGENT_PROCESS_LEDGER } from '../../domains/panel-agent/processes.ts';

/**
 * Ход агента панели (А2) с ФАЛЬШИВЫМ `claude` на PATH: настоящий маршрут,
 * настоящий `spawnCliProcess` (на Windows — через cmd.exe), настоящие временные
 * файлы. Фальшивый CLI снимает свой argv, окружение, stdin, файл системного
 * промпта и конфиг MCP, пока панель их ещё не стёрла, и отвечает кадрами
 * stream-json. Доказательство — этот снимок, а не текст ответа.
 */
const isWindows = process.platform === 'win32';
/** Собран из кусков: присваивание, похожее на ключ, в репозитории не лежит. */
const SECRET = ['contour', 'agent', 'key', '7d1e'].join('-');
/** Ключ формы вендора (`sk-…`) — его ловит встроенный образец `secret_key`. */
const PASTED_KEY = ['sk', 'ant', 'api03', 'Q7rT2xVb9LmN4pZs8KdW'].join('-');
const CONTOUR = 'agent-contour';
const GATEWAY_PORT = 45987;
const SELF = 'http://127.0.0.1:5211';

const FAKE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
// Путь снимка — рядом со скриптом, а не переменной окружения: окружение агента
// теперь список, и переменная теста до процесса не дошла бы.
const DUMP = new URL('./dump.json', import.meta.url);
const SLOW = new URL('./slow-ms.txt', import.meta.url);
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const promptFile = after('--append-system-prompt-file');
const contourFile = after('--system-prompt-file');
const mcpFile = after('--mcp-config');
writeFileSync(DUMP, JSON.stringify({
  argv,
  env: process.env,
  cwd: process.cwd(),
  stdin: Buffer.concat(chunks).toString('utf8'),
  systemPrompt: promptFile ? readFileSync(promptFile, 'utf8') : null,
  contourPrompt: contourFile ? readFileSync(contourFile, 'utf8') : null,
  mcpConfig: mcpFile ? JSON.parse(readFileSync(mcpFile, 'utf8')) : null,
  pid: process.pid,
}));
if (existsSync(SLOW)) await new Promise((done) => setTimeout(done, Number(readFileSync(SLOW, 'utf8'))));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
out({ type: 'system', subtype: 'init' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__${PANEL_AGENT_BRIDGE_ID}__where_am_i', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Вы в разделе проектов.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Вы в разделе проектов.' });
`;

interface Dump {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  systemPrompt: string | null;
  contourPrompt: string | null;
  mcpConfig: { mcpServers: Record<string, { command: string; args: string[]; env: object }> };
  pid: number;
}

describe('POST /api/agent/run', () => {
  let appData: string;
  let bin: string;
  let dumpFile: string;
  let store: AppStore;
  let app: FastifyInstance;
  let gatewayPort: number;
  let pending: PanelPendingActions;
  const savedPath = process.env.PATH;
  const savedDump = process.env.CC_FAKE_DUMP;

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-run-appdata-'));
    bin = mkdtempSync(join(tmpdir(), 'cc-agent-run-bin-'));
    dumpFile = join(bin, 'dump.json');
    const script = join(bin, 'fake-claude.mjs');
    writeFileSync(script, FAKE, 'utf8');
    if (isWindows) {
      writeFileSync(
        join(bin, 'claude.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      );
      // Только фальшивый CLI и System32 (`where`, `cmd.exe`): настоящий
      // `claude.exe` дальше по PATH запустился бы вместо фальшивого.
      const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      process.env.PATH = `${bin}${delimiter}${system32}`;
    } else {
      writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
        {
          mode: 0o755,
        },
      );
      process.env.PATH = `${bin}${delimiter}/usr/bin${delimiter}/bin`;
    }
    process.env.CC_FAKE_DUMP = dumpFile;
    resetCliLookupCache();

    store = new AppStore(appData);
    gatewayPort = GATEWAY_PORT;
    app = await buildApp();
  });

  const buildApp = async (
    extra: Partial<PanelAgentRunRouteDeps> = {},
    panelToken?: string,
  ): Promise<FastifyInstance> => {
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => panelToken !== undefined,
      expectedToken: () => panelToken ?? '',
    };
    pending = new PanelPendingActions(10_000);
    const instance = Fastify();
    registerAccessGate(instance, access);
    registerPanelAgentRoutes(instance, ctx, { hub: createEventHub(), pending, access });
    registerPanelAgentRunRoutes(instance, ctx, {
      selfBaseUrl: SELF,
      gatewayPort: () => gatewayPort,
      pending,
      ...extra,
    });
    await instance.ready();
    return instance;
  };

  afterEach(async () => {
    await app.close();
    process.env.PATH = savedPath;
    if (savedDump === undefined) delete process.env.CC_FAKE_DUMP;
    else process.env.CC_FAKE_DUMP = savedDump;
    resetCliLookupCache();
    rmSync(appData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const run = (body: object) =>
    app.inject({ method: 'POST', url: '/api/agent/run', payload: body });

  const framesOf = (payload: string): PanelAgentRunEvent[] =>
    payload
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as PanelAgentRunEvent);

  const dump = (): Dump => JSON.parse(readFileSync(dumpFile, 'utf8')) as Dump;

  const contour = (contourPrompt = true): void => {
    const platform = platformSchema.parse({
      id: CONTOUR,
      title: 'Контур агента',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.ru',
      enabled: true,
      mode: 'required',
      consumers: ['assistant'],
      contourPrompt,
    });
    writePlatform(store, platform);
    writeToken(appData, CONTOUR, SECRET);
    const profile = buildManagedProfile(
      platform,
      { enabled: true, port: GATEWAY_PORT, forceStream: true },
      'qwen2.5:7b',
    );
    store.updateSettings({
      activePlatformId: CONTOUR,
      endpointProfiles: [profile],
      assistantEndpointId: profile.id,
    });
  };

  const body = {
    conversationId: 'conv-1',
    messages: [{ role: 'user', content: 'Где я? "кавычки" & | > и\nвторая строка' }],
    context: { route: '/projects', title: 'Проекты', projectPath: 'C:\\work\\demo' },
  };

  it('запускает CLI лёгким агентом: только переходник, без встроенных инструментов, промпт файлом', async () => {
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const frames = framesOf(response.payload);
    expect(frames[0]).toEqual({ kind: 'start', conversationId: 'conv-1', providerId: 'claude' });
    expect(frames).toContainEqual({ kind: 'tool', name: 'where_am_i' });
    expect(frames).toContainEqual({ kind: 'tool-result', name: 'where_am_i', isError: false });
    expect(frames.at(-1)).toEqual({ kind: 'done', reply: 'Вы в разделе проектов.' });

    const seen = dump();
    const flag = (name: string): string | undefined => seen.argv[seen.argv.indexOf(name) + 1];
    expect(seen.argv).toContain('-p');
    expect(flag('--output-format')).toBe('stream-json');
    expect(seen.argv).toContain('--verbose');
    expect(seen.argv).toContain('--strict-mcp-config');
    expect(seen.argv).toContain('--no-session-persistence');
    expect(seen.argv).toContain('--disable-slash-commands');
    // Лёгкое окно: без проектного источника — иначе `~/.claude/CLAUDE.md`
    // доезжает поиском вверх от временной папки (`check-run-layers.mjs`, случай 7).
    expect(flag('--setting-sources')).toBe('local');
    for (const arg of lightWindowLayers().args) expect(seen.argv).toContain(arg);
    // Не контур — промпт CLI на месте, своего промпта контура нет.
    expect(seen.argv).not.toContain('--system-prompt-file');
    expect(flag('--tools')).toBe('');
    expect(flag('--allowedTools')).toBe(`mcp__${PANEL_AGENT_BRIDGE_ID}__*`);
    expect(seen.argv).not.toContain('--append-system-prompt');

    // Текст человека — только в stdin, дословно, с кавычками и переводом строки.
    expect(seen.stdin).toBe(body.messages[0]!.content);
    expect(seen.argv.join(' ')).not.toContain('кавычки');
    expect(seen.systemPrompt).toContain('route /projects');
    expect(seen.systemPrompt).toContain('C:\\work\\demo');

    // В конфиге MCP ровно один сервер, и в его окружении ровно адрес панели.
    const servers = seen.mcpConfig.mcpServers;
    expect(Object.keys(servers)).toEqual([PANEL_AGENT_BRIDGE_ID]);
    const bridge = servers[PANEL_AGENT_BRIDGE_ID]!;
    expect(bridge.env).toEqual({ AGENTDECK_URL: SELF });
    expect(bridge.args[0]).toMatch(/tools[\\/]mcp[\\/]panel\.mjs$/);
    expect(bridge.args.slice(1)).toEqual(['--conversation', 'conv-1']);

    expect(seen.env.MCP_TOOL_TIMEOUT).toBe(String(PANEL_AGENT_MCP_TOOL_TIMEOUT_MS));
    expect(seen.env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Рабочий каталог — пустая временная папка, и панель её убрала после хода.
    expect(existsSync(seen.cwd)).toBe(false);

    // Разговор записан вместе с ответом.
    const saved = await app.inject({ method: 'GET', url: '/api/agent/conversations/conv-1' });
    const conversation = saved.json<PanelAgentConversation>();
    expect(conversation.context.route).toBe('/projects');
    expect(conversation.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(conversation.messages[1]!.content).toBe('Вы в разделе проектов.');
    const list = await app.inject({ method: 'GET', url: '/api/agent/conversations' });
    expect(list.json()).toEqual([expect.objectContaining({ id: 'conv-1', messages: 2 })]);
  });

  it('окружение процесса — список: ни ключа API, ни переменных панели, вход в аккаунт на месте', async () => {
    const planted = {
      ANTHROPIC_API_KEY: ['sk', 'ant', 'planted', 'env'].join('-'),
      PLATFORM_API_TOKEN: 'planted-company',
      AGENTDECK_TOKEN: 'planted-panel',
      OPENAI_API_KEY: 'planted-openai',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    // Удалённый доступ включён: телефон решает карточки по этому токену (А8),
    // значит процесс агента не должен получить его ни в окружении, ни в аргументах.
    const PANEL_TOKEN = 'planted-remote-token-' + 'x'.repeat(24);
    await app.close();
    app = await buildApp({}, PANEL_TOKEN);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent/run',
        headers: { authorization: `Bearer ${PANEL_TOKEN}` },
        payload: body,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    // Снимок — НАСТОЯЩЕЕ `process.env` дочернего процесса, а не переданный объект.
    const seen = dump();
    const raw = readFileSync(dumpFile, 'utf8');
    expect(raw).not.toContain(PANEL_TOKEN);
    for (const [key, value] of Object.entries(planted)) {
      expect(seen.env[key], key).toBeUndefined();
      expect(raw).not.toContain(value);
    }
    const names = Object.keys(seen.env).map((name) => name.toLowerCase());
    expect(names).toContain('path');
    expect(seen.env.AGENTDECK_URL).toBe(SELF);
    expect(seen.env.MCP_TOOL_TIMEOUT).toBe(String(PANEL_AGENT_MCP_TOOL_TIMEOUT_MS));
    // Ничего сверх списка и добавки хода (на Windows cmd.exe дописывает своё).
    const allowed = new Set(
      [...PANEL_AGENT_ENV_ALLOWLIST, 'AGENTDECK_URL', 'MCP_TOOL_TIMEOUT'].map((name) =>
        name.toLowerCase(),
      ),
    );
    // Их дописывает сама Windows при старте процесса, а не панель.
    const cmdOwn = new Set(['prompt', 'logonserver', 'userdomain', 'userdomain_roamingprofile']);
    const extra = names.filter(
      (name) => !allowed.has(name) && !cmdOwn.has(name) && !name.startsWith('='),
    );
    expect(extra).toEqual([]);
  });

  it('потолок хода стоит, пока карточка разговора ждёт клика; без карточки — ход снят', async () => {
    await app.close();
    app = await buildApp({ timeoutMs: 300, ceilingTickMs: 50 });
    writeFileSync(join(bin, 'slow-ms.txt'), '1500');

    // Карточка этого разговора висит всё время хода — потолок 300 мс не срабатывает.
    const card = pending.create({
      name: 'save_rule',
      risk: 'change',
      conversationId: 'conv-1',
      preview: { summary: 'x', fields: [] },
    });
    const waited = await run(body);
    pending.cancel(card.pending.id);
    expect(framesOf(waited.payload).at(-1)).toEqual({
      kind: 'done',
      reply: 'Вы в разделе проектов.',
    });

    // Карточка ЧУЖОГО разговора не держит ход: потолок снимает его.
    const other = pending.create({
      name: 'save_rule',
      risk: 'change',
      conversationId: 'conv-other',
      preview: { summary: 'x', fields: [] },
    });
    const killed = await run(body);
    pending.cancel(other.pending.id);
    expect(framesOf(killed.payload).at(-1)).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(framesOf(killed.payload).at(-1))).toContain('отведённое время');
  });

  it('процесс агента в журнале процессов, пока жив; после хода запись снята', async () => {
    writeFileSync(join(bin, 'slow-ms.txt'), '1200');
    const ledger = join(appData, PANEL_AGENT_PROCESS_LEDGER);
    const running = run(body);
    let during: Array<{ key: string; pid: number }> = [];
    for (let attempt = 0; attempt < 100 && during.length === 0; attempt += 1) {
      await new Promise((done) => setTimeout(done, 20));
      if (existsSync(ledger)) during = JSON.parse(readFileSync(ledger, 'utf8'));
    }
    expect(during).toEqual([expect.objectContaining({ key: 'conv-1' })]);
    expect(during[0]!.pid).toBeGreaterThan(0);
    await running;
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual([]);
  });

  it('where_am_i отвечает страницей хода этого разговора', async () => {
    await run(body);
    const answer = await app.inject({
      method: 'POST',
      url: '/api/agent/actions/where_am_i',
      payload: { input: {}, conversationId: 'conv-1' },
    });
    const result = answer.json<PanelActionResult>();
    expect(result.outcome).toBe('done');
    expect(result.result).toEqual({
      known: true,
      route: '/projects',
      title: 'Проекты',
      projectPath: 'C:\\work\\demo',
      section: 'Projects',
    });

    const outside = await app.inject({
      method: 'POST',
      url: '/api/agent/actions/where_am_i',
      payload: { input: {} },
    });
    expect(outside.json<PanelActionResult>().result).toMatchObject({ known: false });
  });

  it('через контур: адрес шлюза и заглушка в окружении процесса, ключа нет нигде', async () => {
    contour();
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    expect(framesOf(response.payload)[0]).toMatchObject({ kind: 'start', contourId: CONTOUR });

    const seen = dump();
    expect(seen.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${GATEWAY_PORT}/${CONTOUR}`);
    expect(seen.env.ANTHROPIC_AUTH_TOKEN).toBe(PLACEHOLDER_KEY);
    expect(seen.env.ANTHROPIC_MODEL).toBe('qwen2.5:7b');
    expect(readFileSync(dumpFile, 'utf8')).not.toContain(SECRET);
    expect(response.payload).not.toContain(SECRET);

    // Промпт контура и снятые слои — как у прогона чата через контур: файлом
    // ВМЕСТО промпта CLI, а дописка агента остаётся.
    const flag = (name: string): string | undefined => seen.argv[seen.argv.indexOf(name) + 1];
    expect(seen.argv).toContain('--system-prompt-file');
    expect(seen.contourPrompt).toContain('qwen2.5:7b');
    expect(seen.contourPrompt).toContain('«Контур агента»');
    expect(seen.systemPrompt).toContain('route /projects');
    expect(flag('--setting-sources')).toBe('local');
    for (const arg of lightWindowLayers().args) expect(seen.argv).toContain(arg);
    expect(seen.argv.join(' ')).not.toContain('Контур агента');
  });

  it('через контур со снятым промптом контура — промпт CLI, слои сняты всё равно', async () => {
    contour(false);
    const response = await run(body);
    expect(response.statusCode).toBe(200);
    const seen = dump();
    expect(seen.env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${GATEWAY_PORT}/${CONTOUR}`);
    expect(seen.argv).not.toContain('--system-prompt-file');
    expect(seen.contourPrompt).toBeNull();
    for (const arg of lightWindowLayers().args) expect(seen.argv).toContain(arg);
  });

  it('ключ в сообщении маскируется до модели и до файла разговора', async () => {
    const secretBody = {
      ...body,
      messages: [
        { role: 'user', content: `подключи контур, вот ключ ${PASTED_KEY}` },
        { role: 'assistant', content: 'Ключ в чат не нужен.' },
        { role: 'user', content: `всё-таки возьми ${PASTED_KEY} и сохрани` },
      ],
    };
    const response = await run(secretBody);
    expect(response.statusCode).toBe(200);

    const seen = dump();
    // Ни в stdin, ни в файлах, ни в argv/окружении процесса.
    expect(readFileSync(dumpFile, 'utf8')).not.toContain(PASTED_KEY);
    // Одно значение — одна метка на весь ход, модели видно, что ключ тот же.
    expect(seen.stdin.match(/\[КЛЮЧ_1\]/g)).toHaveLength(2);
    expect(seen.stdin).toContain('подключи контур, вот ключ [КЛЮЧ_1]');

    const saved = readFileSync(join(appData, 'panel-agent', 'conv-1.json'), 'utf8');
    expect(saved).not.toContain(PASTED_KEY);
    expect(saved).toContain('[КЛЮЧ_1]');
    expect(response.payload).not.toContain(PASTED_KEY);
  });

  it('без своих правил ссылка, адрес, почта и id доходят до модели; ключи и доступ в адресе — нет (D1)', async () => {
    const content =
      'подключи контур, вот ссылка http://127.0.0.1:5222 и https://gw.example.com/v1, ' +
      'хост 10.0.0.7, почта qa@example.com, кейс 3f2c9a1e-8b7d-4c6e-9a01-5d4e3c2b1a09, ' +
      `ключ ${PASTED_KEY}, доступ https://bob:pa55word@git.example.com/repo.git`;
    const response = await run({ ...body, messages: [{ role: 'user', content }] });
    expect(response.statusCode).toBe(200);
    const seen = dump();
    expect(seen.stdin).toContain('вот ссылка http://127.0.0.1:5222 и https://gw.example.com/v1');
    expect(seen.stdin).toContain('хост 10.0.0.7, почта qa@example.com');
    expect(seen.stdin).toContain('кейс 3f2c9a1e-8b7d-4c6e-9a01-5d4e3c2b1a09');
    expect(seen.stdin).not.toContain(PASTED_KEY);
    expect(seen.stdin).not.toContain('pa55word');
  });

  it('ключ маскируется и поверх своих правил раздела, где образца ключей нет', async () => {
    writeFileSync(
      join(appData, 'dlp-rules.json'),
      JSON.stringify({
        rules: [
          {
            id: 'own-name',
            name: 'Фамилия',
            enabled: true,
            kind: 'terms',
            terms: ['Иванов'],
            pattern: '',
            action: 'mask',
            label: 'ИМЯ',
          },
        ],
      }),
    );
    const response = await run({
      ...body,
      messages: [{ role: 'user', content: `Иванов прислал ${PASTED_KEY}` }],
    });
    expect(response.statusCode).toBe(200);
    const seen = dump();
    expect(seen.stdin).toBe('[ИМЯ_1] прислал [КЛЮЧ_1]');
  });

  it('битые правила защиты данных — отказ data_mask_broken, CLI не запускался', async () => {
    writeFileSync(join(appData, 'dlp-rules.json'), '{ не json');
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'data_mask_broken' });
    expect(existsSync(dumpFile)).toBe(false);
    expect(existsSync(join(appData, 'panel-agent', 'conv-1.json'))).toBe(false);
  });

  it('контур без шлюза — отказ до запуска, CLI не запускался', async () => {
    contour();
    gatewayPort = 0;
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'contour_unreachable' });
    expect(existsSync(dumpFile)).toBe(false);
  });

  it('свой эндпоинт ассистента (не контур) — отказ endpoint_unsupported', async () => {
    store.updateSettings({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Свой шлюз',
          baseUrl: 'http://127.0.0.1:9',
          apiKind: 'anthropic',
          model: '',
          writeToken: false,
          imagesUrl: '',
          ownerPlatformId: '',
        },
      ],
      assistantEndpointId: 'own',
    });
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'endpoint_unsupported' });
    expect(existsSync(dumpFile)).toBe(false);
  });

  it('чужой активный CLI — отказ provider_unsupported', async () => {
    store.updateSettings({ provider: 'codex' });
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'provider_unsupported' });
  });

  it('claude нет в PATH — отказ cli_not_found', async () => {
    rmSync(join(bin, isWindows ? 'claude.cmd' : 'claude'));
    resetCliLookupCache();
    const response = await run(body);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'cli_not_found' });
  });

  it('неверное тело — 400: последняя реплика не человека, id с метасимволами', async () => {
    const assistantLast = await run({
      ...body,
      messages: [{ role: 'assistant', content: 'привет' }],
    });
    expect(assistantLast.statusCode).toBe(400);
    const badId = await run({ ...body, conversationId: 'a&calc' });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({ error: 'invalid_body' });
  });
});
