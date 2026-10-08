import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform, PlatformRulesApplies } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../store/store.ts';
import type { PlatformFetch } from '../ca-fetch/ca-fetch.ts';
import { PlatformGateway } from './listener/listener.ts';
import { splitPath } from './pipeline/pipeline.ts';

/**
 * Баг 11 на настоящем слушателе: закрытый раздел отказывает В ШЛЮЗЕ, на каждом
 * запросе (а), и выбор «чьи правила действуют» меняет то, что уходит в контур (б).
 *
 * Контур подставлен на границе сети — ровно там, где проверка ничего не теряет:
 * вопрос в том, ушёл ли запрос и с каким телом, а это видно по вызову наружу.
 */

const SECRET = 'platform-token-5e1a';
const DELTA = '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"да"}}]}';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  // Открыт только чат: ассистент, терминал и остальные — закрыты.
  consumers: ['chat'],
  agents: [],
  budgetSince: '',
  toolShim: false,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls: { url: string; body: string }[] = [];

const upstream: PlatformFetch = (url, init) => {
  calls.push({ url, body: init?.body ?? '' });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of [DELTA, '[DONE]'])
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return Promise.resolve(
    new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
};

async function ask(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'gpt-x',
      stream: true,
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
  return { status: response.status, text: await response.text() };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-section-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
  calls = [];
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl: upstream,
    spendFlushMs: 0,
  });
  port = gateway.status().port;
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('отметка раздела в адресе', () => {
  it('разбирается вместе с меткой прогона и не путается с маршрутом', () => {
    expect(splitPath('/c/_s/chat/v1/messages?key=1')).toEqual({
      platformId: 'c',
      rest: '/v1/messages',
      section: 'chat',
    });
    expect(splitPath('/c/_s/foreign/codex/_run/t-1/v1/chat/completions')).toEqual({
      platformId: 'c',
      rest: '/v1/chat/completions',
      runTag: 't-1',
      section: 'foreign:codex',
    });
    // Незнакомая отметка — не «без отметки»: иначе опечатка открывала бы закрытое.
    expect(splitPath('/c/_s/nope/v1/messages')).toMatchObject({ badSection: true });
    expect(splitPath('/c/_s/foreign/v1/messages').section).toBe('foreign:v1');
    // Адрес без отметки остаётся прежним.
    expect(splitPath('/c/v1/messages')).toEqual({ platformId: 'c', rest: '/v1/messages' });
  });
});

describe('закрытый раздел закрыт в шлюзе (баг 11а)', () => {
  it('открытый раздел проходит, след называет раздел, путь — без отметки', async () => {
    const answer = await ask('/enterprise-platform/_s/chat/v1/chat/completions');
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(gateway.status().events[0]).toMatchObject({
      status: 200,
      section: 'chat',
      path: '/enterprise-platform/v1/chat/completions',
    });
  });

  it('закрытый раздел — 403 без похода в контур, причина названа словами', async () => {
    const answer = await ask('/enterprise-platform/_s/assistant/v1/chat/completions');
    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(answer.text).toContain('Ассистент панели');
    expect(JSON.parse(answer.text)).toMatchObject({ error: { type: 'permission_error' } });
    expect(gateway.status().events[0]).toMatchObject({ status: 403, section: 'assistant' });
  });

  it('клиент в диалекте anthropic получает отказ своей формы', async () => {
    const answer = await ask('/enterprise-platform/_s/terminal/v1/messages', {
      'anthropic-version': '2023-06-01',
    });
    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(answer.text)).toMatchObject({
      type: 'error',
      error: { type: 'permission_error' },
    });
  });

  it('снятая галочка действует на следующем же запросе, без перезапуска', async () => {
    expect((await ask('/enterprise-platform/_s/chat/v1/chat/completions')).status).toBe(200);
    writePlatform(store, { ...PLATFORM, consumers: [] });
    const closed = await ask('/enterprise-platform/_s/chat/v1/chat/completions');
    expect(closed.status).toBe(403);
    expect(closed.text).toContain('Чат');
    expect(calls).toHaveLength(1);
  });

  it('незнакомая отметка — отказ, а не проход', async () => {
    const answer = await ask('/enterprise-platform/_s/nope/v1/chat/completions');
    expect(answer.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('чужой CLI закрыт своим именем', async () => {
    const answer = await ask('/enterprise-platform/_s/foreign/qwen/v1/chat/completions');
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('Qwen');
    expect(gateway.status().events[0]).toMatchObject({ section: 'foreign:qwen' });
  });

  it('адрес без отметки проходит — свои проверки панели и старые файлы', async () => {
    writePlatform(store, { ...PLATFORM, consumers: [] });
    const answer = await ask('/enterprise-platform/v1/chat/completions');
    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(gateway.status().events[0]).not.toHaveProperty('section');
  });
});

describe('чьи правила действуют (баг 11б)', () => {
  const RULES = {
    platformTools: ['web_search'],
    toolMode: 'loop' as const,
    generationPreset: 'precise',
    enableThinking: 'on' as const,
  };

  async function sentWith(applies: PlatformRulesApplies | undefined): Promise<string> {
    writePlatform(store, {
      ...PLATFORM,
      rules: {
        platform: RULES,
        ours: defaultOurRules(),
        ...(applies ? { applies } : {}),
      },
    });
    calls = [];
    const answer = await ask('/enterprise-platform/_s/chat/v1/chat/completions');
    expect(answer.status).toBe(200);
    return calls[0]?.body ?? '';
  }

  it('оба набора и «только контур» отправляют правила контура', async () => {
    for (const applies of [undefined, 'both', 'contour'] as const) {
      const body = await sentWith(applies);
      expect(body).toContain('web_search');
      expect(body).toContain('precise');
      expect(body).toContain('"enable_thinking":true');
    }
  });

  it('«только наши» — контуру уходит одно «инструментов не надо»', async () => {
    const body = JSON.parse(await sentWith('ours')) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('web_search');
    expect(JSON.stringify(body)).not.toContain('precise');
    expect(JSON.stringify(body)).not.toContain('enable_thinking');
    expect(body.tool_choice).toBe('none');
  });
});
