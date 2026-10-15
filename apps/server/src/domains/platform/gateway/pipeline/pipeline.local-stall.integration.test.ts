import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../../store/store.ts';
import type { PlatformFetch } from '../../ca-fetch/ca-fetch.ts';
import { driverFor } from '../../drivers/index.ts';
import { PlatformGateway } from '../listener/listener.ts';
import { createActivityWatch } from '../../../local-models/activity.ts';
import type { SlotState } from '../../../local-models/llama-client.ts';

/**
 * Чат на локальной модели молчал до 20 минут (L6, 14.10): запрос ушёл, сервер с ним
 * ничего не делал, а срок первого байта — десятки минут. Здесь настоящий путь — слушатель,
 * HTTP «CLI» и настоящий присмотр (`activity.ts`) с опросом заглушки сервера; подменены
 * только ответы сервера моделей. Тишина — обрыв и 529, который Claude Code повторяет;
 * движение разбора — ждать сколько угодно.
 */

const PLATFORM: Platform = {
  id: 'local-stall-test',
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
  defaultModel: 'qwen-local',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const driver = driverFor('enterprise-platform');
const declared = { ...driver };

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;

const STREAM = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'qwen-local',
        content: [],
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ответ' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'message_delta',
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
  ],
  ['message_stop', { type: 'message_stop' }],
]
  .map(([event, data]) => `event: ${String(event)}\ndata: ${JSON.stringify(data)}\n\n`)
  .join('');

/** Сервер, который держит запрос, пока его не оборвут, — или отвечает через `answerAfterMs`. */
function server(answerAfterMs?: number): PlatformFetch {
  return (url, init) => {
    if (String(url).endsWith('/count_tokens'))
      return Promise.resolve(new Response('{}', { status: 404 }));
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer =
        answerAfterMs === undefined
          ? undefined
          : setTimeout(
              () =>
                resolve(
                  new Response(STREAM, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                  }),
                ),
              answerAfterMs,
            );
      signal?.addEventListener(
        'abort',
        () => {
          if (timer) clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  };
}

async function start(
  upstream: PlatformFetch,
  slot: () => SlotState,
): Promise<{ wedged: () => number; watch: ReturnType<typeof createActivityWatch> }> {
  let wedged = 0;
  const watch = createActivityWatch({
    health: () => Promise.resolve('ok'),
    slot: () => Promise.resolve(slot()),
    server: () => ({ model: 'qwen-local', context: 65_536, device: 'gpu' }),
    onWedged: () => {
      wedged += 1;
    },
    stallText: (seconds) => `сервер моделей ${seconds} с не двигался с запросом`,
    intervalMs: 20,
    stallMs: () => 300,
  });
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl: upstream,
    spendFlushMs: 0,
  });
  gateway.setLocalUpstream((platformId) =>
    platformId === PLATFORM.id
      ? { context: 65_536, watch: (tokens: number) => watch.track(tokens) }
      : undefined,
  );
  port = gateway.status().port;
  return { wedged: () => wedged, watch };
}

function ask(): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'qwen-local',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-stall-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('сервер моделей молчит с запросом — обрыв и повтор, а не 20 минут тишины (L6)', () => {
  it('слот застыл посреди разбора — 529 «перегрузка» с причиной, сервер перезапускается', async () => {
    const h = await start(server(), () => ({ processing: true, filled: 4_096, decoded: 0 }));
    const begun = Date.now();
    const answer = await ask();
    const body = (await answer.json()) as { error: { type: string; message: string } };
    expect(answer.status).toBe(529);
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toMatch(/не двигался с запросом/);
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(h.wedged()).toBe(1);
  });

  it('путь через перевод в chat/completions — тот же обрыв с причиной, а не ожидание до срока первого байта', async () => {
    // Драйвер без родного /v1/messages: запрос идёт мостом, своим вызовом `callUpstream`.
    Object.assign(driver, { anthropic: undefined });
    const h = await start(server(), () => ({ processing: true, filled: 2_048, decoded: 0 }));
    const begun = Date.now();
    const answer = await ask();
    const body = (await answer.json()) as { error: { type: string; message: string } };
    expect(answer.status).toBe(529);
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toMatch(/не двигался с запросом/);
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(h.wedged()).toBe(1);
  });

  it('разбор движется дольше срока тишины — ответ доходит целиком, обрыва нет', async () => {
    let filled = 0;
    const h = await start(server(900), () => {
      filled += 512;
      return { processing: true, filled, decoded: 0 };
    });
    const answer = await ask();
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('ответ');
    expect(h.wedged()).toBe(0);
  });
});

/** Отказ llama.cpp ровно в том виде, что пришёл от шаблона Qwen3.8 (15.10). */
const JINJA_500 = {
  error: {
    code: 500,
    message: [
      '',
      '------------',
      'While executing CallExpression at line 110, column 28 in source:',
      `...eveloper" %}↵        {{- raise_exception('System message must be at the beginnin...`,
      '                                           ^',
      'Error: Jinja Exception: System message must be at the beginning.',
    ].join('\n'),
    type: 'server_error',
  },
};

/** Отказ шаблона на каждый запрос (повторы шлюза тоже), пока `fixed` не поднят. */
function failingUntilFixed(state: { fixed: boolean }): PlatformFetch {
  return (url) => {
    if (String(url).endsWith('/count_tokens'))
      return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      !state.fixed
        ? new Response(JSON.stringify(JINJA_500), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

describe('сервер моделей отвечает отказом — чат видит код и текст, а не «выполняет инструменты» (L6)', () => {
  const idleSlot = (): SlotState => ({ processing: false, filled: 0, decoded: 0 });

  for (const route of ['родная ручка', 'перевод в chat/completions'] as const) {
    it(`${route}: отказ шаблона запомнен последней строкой, удачный ответ его стирает`, async () => {
      if (route !== 'родная ручка') Object.assign(driver, { anthropic: undefined });
      const state = { fixed: false };
      const h = await start(failingUntilFixed(state), idleSlot);
      const before = Date.now();
      const failed = await ask();
      expect(failed.status).toBeGreaterThanOrEqual(400);
      await failed.text();
      const snap = h.watch.snapshot();
      expect(snap.lastError).toMatchObject({
        status: 500,
        message: 'Error: Jinja Exception: System message must be at the beginning.',
      });
      expect(snap.lastRequestAt).toBeGreaterThanOrEqual(before);
      state.fixed = true;
      const ok = await ask();
      expect(ok.status).toBe(200);
      await ok.text();
      expect(h.watch.snapshot().lastError).toBeUndefined();
    });
  }
});
