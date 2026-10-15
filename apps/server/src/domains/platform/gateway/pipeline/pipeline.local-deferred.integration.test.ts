import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../../store/store.ts';
import type { PlatformFetch } from '../../ca-fetch/ca-fetch.ts';
import { driverFor } from '../../drivers/index.ts';
import { PlatformGateway } from '../listener/listener.ts';
import { DEFERRED_TOOL_MARK } from '../local-window/deferred-tools.ts';

/**
 * Отложенные инструменты на настоящем пути шлюза (L7): слушатель, настоящий HTTP от
 * «CLI» с телом формы `claude` 2.1.286 после `ToolSearch`, подменён только сервер
 * моделей — он записывает, что до него дошло. Проверяется и ход, и счёт токенов: счёт
 * по другому телу сказал бы про другой запрос.
 */

const PLATFORM: Platform = {
  id: 'local-deferred-test',
  title: 'Локальная модель',
  driver: 'enterprise-platform',
  baseUrl: 'http://127.0.0.1:11435',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: false,
  contourPrompt: false,
  defaultModel: 'qwen3.8:27b',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const wire = JSON.parse(
  readFileSync(
    new URL('../local-window/__fixtures__/tool-search-2.1.286.json', import.meta.url),
    'utf8',
  ),
) as { after: Record<string, unknown> };

const driver = driverFor('enterprise-platform');
const declared = { ...driver };

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
const seen: { path: string; body: Record<string, unknown> }[] = [];

const ANSWER = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'qwen3.8:27b',
        content: [],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

const recordingServer: PlatformFetch = (url, init) => {
  const path = String(url);
  seen.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
  if (path.endsWith('/count_tokens')) return Promise.resolve(Response.json({ input_tokens: 1234 }));
  return Promise.resolve(
    new Response(ANSWER, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
};

async function start(local: { deferredInline: boolean } | undefined): Promise<void> {
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl: recordingServer,
    spendFlushMs: 0,
  });
  if (local)
    gateway.setLocalUpstream((platformId) =>
      platformId === PLATFORM.id ? { context: 65_536, ...local } : undefined,
    );
  port = gateway.status().port;
}

const post = (path: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...wire.after, stream: path === 'messages' }),
  });

type Tool = { name: string; description?: string; defer_loading?: boolean };
const toolsOf = (body: Record<string, unknown> | undefined): Tool[] =>
  (body?.tools ?? []) as Tool[];
const chatBody = (): Record<string, unknown> | undefined =>
  seen.find((item) => item.path.endsWith('/messages'))?.body;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-deferred-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  seen.length = 0;
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('отложенные инструменты на пути к локальной модели', () => {
  it('до сервера доходит развёрнутое: ни defer_loading, ни tool_reference, ни заглушки', async () => {
    await start({ deferredInline: true });
    const answer = await post('messages');
    await answer.text();

    expect(answer.status).toBe(200);
    const body = chatBody();
    const text = JSON.stringify(body);
    expect(text).not.toContain('defer_loading');
    expect(text).not.toContain('tool_reference');
    expect(toolsOf(body).map((tool) => tool.name)).not.toContain('DeferredToolPlaceholder');
    expect(text).toContain('<function>{\\"description\\"');
    expect(toolsOf(body).find((tool) => tool.name === 'mcp__t8marker__marker')).toMatchObject({
      description: DEFERRED_TOOL_MARK,
    });
  });

  it('шаблон без пометки: подгруженный инструмент уходит с настоящим описанием', async () => {
    await start({ deferredInline: false });
    await (await post('messages')).text();
    const marker = toolsOf(chatBody()).find((tool) => tool.name === 'mcp__t8marker__marker');
    expect(marker?.description).not.toBe(DEFERRED_TOOL_MARK);
    expect(marker?.defer_loading).toBeUndefined();
  });

  it('счёт токенов идёт по тому же развёрнутому телу, что и ход', async () => {
    await start({ deferredInline: true });
    const answer = await post('messages/count_tokens');
    expect(await answer.json()).toEqual({ input_tokens: 1234 });
    const counted = seen.find((item) => item.path.endsWith('/count_tokens'))?.body;
    expect(JSON.stringify(counted)).not.toContain('tool_reference');
    expect(toolsOf(counted).map((tool) => tool.name)).not.toContain('DeferredToolPlaceholder');
  });

  it('не локальный контур: тело уходит как пришло — облако разворачивает само', async () => {
    await start(undefined);
    await (await post('messages')).text();
    const text = JSON.stringify(chatBody());
    expect(text).toContain('defer_loading');
    expect(text).toContain('tool_reference');
  });
});
