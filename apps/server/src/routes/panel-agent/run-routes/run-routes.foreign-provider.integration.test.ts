import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PanelAgentRunEvent } from '@agentdeck/contracts/panel-agent';
import {
  PANEL_AGENT_BRIDGE_ID,
  PANEL_AGENT_MCP_TOOL_TIMEOUT_MS,
} from '@agentdeck/contracts/panel-agent';
import { platformSchema } from '@agentdeck/contracts/platform';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { resetCliLookupCache } from '../../../providers/detect/detect.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import { buildManagedProfile } from '../../../domains/platform/apply/profile.ts';
import { writePlatform, writeToken } from '../../../domains/platform/store/store.ts';
import {
  CODEX_DISABLED_FEATURES,
  QWEN_EXCLUDED_TOOLS,
} from '../../../domains/panel-agent/foreign-cli/foreign-cli.ts';
import { registerPanelAgentRunRoutes } from './run-routes.ts';

/**
 * Агент панели у чужого CLI (Qwen Code, Codex): настоящий маршрут, настоящий
 * `spawnCliProcess`, фальшивые `qwen` / `codex` на PATH. Фальшивый CLI снимает
 * argv, окружение, stdin и конфиг MCP, пока панель их не стёрла, и отвечает в
 * формате своего CLI — формат снят с настоящих qwen 0.25.0 и codex 0.160.0 на
 * заглушке модели (`.agent/provider-formats.agent.md` §panel agent).
 * Доказательство — снимок запуска и кадры окна, а не текст ответа.
 */
const isWindows = process.platform === 'win32';
const SELF = 'http://127.0.0.1:5211';
const TOOL = `mcp__${PANEL_AGENT_BRIDGE_ID}__where_am_i`;

const DUMP_HEAD = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const DUMP = new URL('./dump.json', import.meta.url);
const EXTRA = new URL('./extra-tool.txt', import.meta.url);
const FAIL = new URL('./fail.txt', import.meta.url);
const after = (flag) => { const at = argv.indexOf(flag); return at >= 0 ? argv[at + 1] : undefined; };
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const mcpFile = after('--mcp-config');
writeFileSync(DUMP, JSON.stringify({
  argv,
  env: process.env,
  stdin: Buffer.concat(chunks).toString('utf8'),
  mcpConfig: mcpFile ? JSON.parse(readFileSync(mcpFile, 'utf8')) : null,
}));
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
`;

/** Кадры \`qwen --output-format stream-json\` 0.25.0: форма Claude, init со списком tools. */
const FAKE_QWEN = `${DUMP_HEAD}
const tools = ['${TOOL}', ...(existsSync(EXTRA) ? ['run_shell_command'] : [])];
out({ type: 'system', subtype: 'init', tools, mcp_servers: [{ name: '${PANEL_AGENT_BRIDGE_ID}', status: 'connected' }] });
if (existsSync(EXTRA)) await new Promise((done) => setTimeout(done, 20000));
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call_1', name: '${TOOL}', input: {} }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', is_error: false, content: 'route /projects' }] } });
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Вы в разделе проектов.' }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Вы в разделе проектов.' });
`;

/** JSONL \`codex exec --json\` 0.160.0: item.started/completed, turn.completed. */
const FAKE_CODEX = `${DUMP_HEAD}
out({ type: 'thread.started', thread_id: 't' });
out({ type: 'turn.started' });
out({ type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: '${PANEL_AGENT_BRIDGE_ID}', tool: 'where_am_i', arguments: {}, result: null, error: null, status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: '${PANEL_AGENT_BRIDGE_ID}', tool: 'where_am_i', arguments: {}, result: { content: [{ type: 'text', text: 'route /projects' }] }, error: null, status: 'completed' } });
if (existsSync(FAIL)) {
  out({ type: 'error', message: 'stream disconnected' });
  out({ type: 'turn.failed', error: { message: 'model refused: quota' } });
  process.exit(1);
}
out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Вы в разделе проектов.' } });
out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
`;

interface Dump {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  mcpConfig: {
    mcpServers: Record<string, { command: string; args: string[]; env: object; timeout?: number }>;
  } | null;
}

describe('POST /api/agent/run — агент у чужого CLI', () => {
  let appData: string;
  let bin: string;
  let store: AppStore;
  let app: FastifyInstance;
  const savedPath = process.env.PATH;

  const install = (name: string, source: string): void => {
    const script = join(bin, `fake-${name}.mjs`);
    writeFileSync(script, source, 'utf8');
    if (isWindows) {
      // Форма обёртки npm старого образца: панель запускает node напрямую, без cmd.exe.
      writeFileSync(join(bin, `${name}.cmd`), `@node "%~dp0\\fake-${name}.mjs" %*\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        mode: 0o755,
      });
    }
  };

  beforeEach(async () => {
    appData = mkdtempSync(join(tmpdir(), 'cc-agent-foreign-appdata-'));
    bin = mkdtempSync(join(tmpdir(), 'cc-agent-foreign-bin-'));
    install('qwen', FAKE_QWEN);
    install('codex', FAKE_CODEX);
    const node = join(process.execPath, '..');
    process.env.PATH = isWindows
      ? `${bin}${delimiter}${node}${delimiter}${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`
      : `${bin}${delimiter}${node}${delimiter}/usr/bin${delimiter}/bin`;
    resetCliLookupCache();
    store = new AppStore(appData);
    const ctx = { store, location: { paths: { appData } } } as unknown as ServerContext;
    app = Fastify();
    registerPanelAgentRunRoutes(app, ctx, {
      selfBaseUrl: SELF,
      gatewayPort: () => 45987,
      pending: new PanelPendingActions(10_000),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    process.env.PATH = savedPath;
    resetCliLookupCache();
    rmSync(appData, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  });

  const body = {
    conversationId: 'conv-f',
    messages: [{ role: 'user', content: 'Где я? "кавычки" & | >\nвторая строка' }],
    context: { route: '/projects', title: 'Проекты' },
  };
  const run = (payload: object = body) =>
    app.inject({ method: 'POST', url: '/api/agent/run', payload });
  const framesOf = (payload: string): PanelAgentRunEvent[] =>
    payload
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as PanelAgentRunEvent);
  const dump = (): Dump => JSON.parse(readFileSync(join(bin, 'dump.json'), 'utf8')) as Dump;
  const flag = (argv: string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];

  it('Qwen Code: лёгкий агент — safe-mode, только переходник, встроенные сняты, ответ и действие в окне', async () => {
    store.updateSettings({ provider: 'qwen' });
    const response = await run();
    expect(response.statusCode).toBe(200);
    const frames = framesOf(response.payload);
    expect(frames[0]).toEqual({ kind: 'start', conversationId: 'conv-f', providerId: 'qwen' });
    expect(frames).toContainEqual({ kind: 'tool', name: 'where_am_i' });
    expect(frames).toContainEqual({ kind: 'tool-result', name: 'where_am_i', isError: false });
    expect(frames.at(-1)).toEqual({ kind: 'done', reply: 'Вы в разделе проектов.' });

    const seen = dump();
    expect(seen.argv).toContain('--safe-mode');
    expect(seen.argv).toContain('--chat-recording=false');
    expect(flag(seen.argv, '--output-format')).toBe('stream-json');
    expect(flag(seen.argv, '--allowed-mcp-server-names')).toBe(PANEL_AGENT_BRIDGE_ID);
    expect(flag(seen.argv, '--allowed-tools')).toBe(`mcp__${PANEL_AGENT_BRIDGE_ID}__*`);
    expect(flag(seen.argv, '--exclude-tools')?.split(',')).toEqual([...QWEN_EXCLUDED_TOOLS]);
    expect(flag(seen.argv, '--exclude-tools')?.split(',')).toContain('run_shell_command');
    // Системная дописка агента — целиком одним аргументом, с переводами строк.
    const prompt = flag(seen.argv, '--append-system-prompt') ?? '';
    expect(prompt).toContain('You are the agent of the AgentDeck panel');
    expect(prompt).toContain('\n');
    // Разговор — stdin байт в байт, позиционного промпта нет.
    expect(seen.stdin).toBe(body.messages[0]!.content);
    expect(seen.argv.at(-2)).toBe('--append-system-prompt');
    // Из MCP — только переходник со своим потолком ожидания карточки.
    const servers = seen.mcpConfig?.mcpServers ?? {};
    expect(Object.keys(servers)).toEqual([PANEL_AGENT_BRIDGE_ID]);
    expect(servers[PANEL_AGENT_BRIDGE_ID]!.env).toEqual({ AGENTDECK_URL: SELF });
    expect(servers[PANEL_AGENT_BRIDGE_ID]!.args).toContain('conv-f');
    expect(servers[PANEL_AGENT_BRIDGE_ID]!.timeout).toBe(PANEL_AGENT_MCP_TOOL_TIMEOUT_MS);
  });

  it('Qwen Code с лишним встроенным инструментом в init — ход оборван до модели, а не агент с руками', async () => {
    store.updateSettings({ provider: 'qwen' });
    writeFileSync(join(bin, 'extra-tool.txt'), '1');
    const started = Date.now();
    const response = await run();
    const frames = framesOf(response.payload);
    const last = frames.at(-1);
    expect(last?.kind).toBe('error');
    expect(last && 'message' in last ? last.message : '').toContain('run_shell_command');
    expect(frames.some((frame) => frame.kind === 'tool')).toBe(false);
    // Процесс снят сразу, а не дожидаясь своих 20 секунд.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('Codex: exec без конфига человека, без оболочки, переходник без вопроса; события сведены к кадрам окна', async () => {
    store.updateSettings({ provider: 'codex' });
    const response = await run();
    expect(response.statusCode).toBe(200);
    const frames = framesOf(response.payload);
    expect(frames[0]).toEqual({ kind: 'start', conversationId: 'conv-f', providerId: 'codex' });
    expect(frames).toContainEqual({ kind: 'tool', name: 'where_am_i' });
    expect(frames).toContainEqual({ kind: 'tool-result', name: 'where_am_i', isError: false });
    expect(frames.at(-1)).toEqual({ kind: 'done', reply: 'Вы в разделе проектов.' });

    const seen = dump();
    expect(seen.argv[0]).toBe('exec');
    expect(seen.argv.at(-1)).toBe('-');
    for (const required of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']) {
      expect(seen.argv).toContain(required);
    }
    expect(flag(seen.argv, '--sandbox')).toBe('read-only');
    const disabled = seen.argv.flatMap((arg, at) =>
      arg === '--disable' ? [seen.argv[at + 1]] : [],
    );
    expect(disabled).toEqual([...CODEX_DISABLED_FEATURES]);
    expect(disabled).toContain('shell_tool');
    const overrides = seen.argv.flatMap((arg, at) => (arg === '-c' ? [seen.argv[at + 1]!] : []));
    const server = overrides.find((item) =>
      item.startsWith(`mcp_servers.${PANEL_AGENT_BRIDGE_ID}=`),
    );
    expect(server).toContain('default_tools_approval_mode="approve"');
    // Без `required` Codex под нагрузкой начинал ход до того, как переходник отдал
    // список действий, и модель оставалась без инструментов панели (20 из 48 ходов
    // на `.agent/tmp/codex-bridge-race.mjs`); с ним — ждёт переходник.
    expect(server).toContain('required=true');
    expect(server).toContain(`env={AGENTDECK_URL="${SELF}"}`);
    expect(server).toContain('"conv-f"');
    expect(overrides).toContain('web_search="disabled"');
    const instructions = overrides.find((item) => item.startsWith('developer_instructions='));
    expect(JSON.parse(instructions!.slice('developer_instructions='.length))).toContain(
      'You are the agent of the AgentDeck panel',
    );
    expect(seen.stdin).toBe(body.messages[0]!.content);
  });

  it('Codex: проваленный ход — ошибка с причиной CLI, не пустой ответ', async () => {
    store.updateSettings({ provider: 'codex' });
    writeFileSync(join(bin, 'fail.txt'), '1');
    const response = await run();
    const last = framesOf(response.payload).at(-1);
    expect(last).toEqual({ kind: 'error', message: 'model refused: quota' });
  });

  it('Codex: картинка уходит файлом через -i, stdin остаётся текстом', async () => {
    store.updateSettings({ provider: 'codex' });
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const response = await run({
      ...body,
      images: [{ name: 'shot.png', mediaType: 'image/png', base64: png }],
    });
    expect(response.statusCode).toBe(200);
    const seen = dump();
    expect(seen.argv[1]).toBe('-i');
    expect(seen.argv[2]).toMatch(/image-1\.png$/);
    expect(seen.stdin).toBe(body.messages[0]!.content);
  });

  // Goose агента панели получил (`goose-agent.ts`) — без запуска агента остался Aider.
  it('CLI без запуска агента (Aider) — отказ с кодом и именем CLI, а не Claude молчком', async () => {
    store.updateSettings({ provider: 'aider' });
    const response = await run();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'provider_unsupported',
      messageCode: 'panel-agent-provider-unsupported',
      params: { provider: 'Aider' },
    });
    expect(existsSync(join(bin, 'dump.json'))).toBe(false);
  });

  it('Qwen Code не на PATH — cli_not_found с именем CLI', async () => {
    store.updateSettings({ provider: 'qwen' });
    rmSync(join(bin, isWindows ? 'qwen.cmd' : 'qwen'));
    resetCliLookupCache();
    const response = await run();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'cli_not_found',
      messageCode: 'panel-agent-cli-not-found',
      params: { provider: 'Qwen Code' },
    });
  });

  it('ассистент через контур, активный Qwen — отказ, ход в облако вендора не идёт', async () => {
    const platform = platformSchema.parse({
      id: 'c1',
      title: 'Контур',
      driver: 'enterprise-platform',
      baseUrl: 'https://api.dev.example.ru',
      enabled: true,
      mode: 'required',
      consumers: ['assistant'],
    });
    writePlatform(store, platform);
    writeToken(appData, 'c1', ['contour', 'key', '9f2a'].join('-'));
    const profile = buildManagedProfile(
      platform,
      { enabled: true, port: 45987, forceStream: true },
      'm',
    );
    store.updateSettings({
      provider: 'qwen',
      endpointProfiles: [profile],
      assistantEndpointId: profile.id,
    });
    const response = await run();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'provider_unsupported',
      messageCode: 'panel-agent-contour-foreign',
      params: { provider: 'Qwen Code' },
    });
    expect(existsSync(join(bin, 'dump.json'))).toBe(false);
  });
});
