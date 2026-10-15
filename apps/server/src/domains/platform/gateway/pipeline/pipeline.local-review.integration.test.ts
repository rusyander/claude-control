import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { createActivityWatch, type ActivityWatch } from '../../../local-models/activity.ts';
import type { LocalUpstreamInfo } from '../local-window/local-window.ts';
import { LOCAL_WATCHED_FIRST_BYTE_MS } from './pipeline.ts';
import { LOCAL_FIRST_TOKEN_FLOOR_MS } from '../local-window/local-window.ts';

/**
 * Находки ревью L6 на настоящем пути шлюза: слушатель, HTTP-клиент, настоящий присмотр
 * (`activity.ts`); подменён только сервер моделей.
 * - B1: шлюз меряет слой (системный промпт и инструменты) и отдаёт его панели;
 * - M3: под присмотром срок первого байта — не расчёт по замеру скорости, а страховка;
 * - m3: клиент, ушедший до начала присмотра, не оставляет запрос висеть в присмотре.
 */

const PLATFORM: Platform = {
  id: 'local-review-test',
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

const STREAM = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'm1',
      type: 'message',
      role: 'assistant',
      model: 'qwen-local',
      content: [],
      usage: { input_tokens: 50, output_tokens: 1 },
    },
  })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
].join('\n');

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let watch: ActivityWatch;
/** Сигналы запросов, ушедших к серверу моделей: ушедший клиент обязан их оборвать. */
let upstreamSignals: AbortSignal[] = [];

/** Сервер моделей: держит запрос, пока его не оборвут, или отвечает через `answerAfterMs`. */
function upstream(answerAfterMs?: number): PlatformFetch {
  return (url, init) => {
    if (String(url).endsWith('/count_tokens'))
      return Promise.resolve(new Response('{}', { status: 404 }));
    if (init?.signal) upstreamSignals.push(init.signal);
    return new Promise<Response>((resolve, reject) => {
      // Как настоящий fetch: уже отменённый сигнал — отказ сразу.
      if (init?.signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
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
      init?.signal?.addEventListener(
        'abort',
        () => {
          if (timer) clearTimeout(timer);
          reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  };
}

async function start(
  fetchImpl: PlatformFetch,
  extra: Partial<LocalUpstreamInfo> = {},
): Promise<void> {
  watch = createActivityWatch({
    health: () => Promise.resolve('ok'),
    slot: () => Promise.resolve({ processing: false, filled: 0, decoded: 0 }),
    server: () => ({ model: 'qwen-local', context: 65_536, device: 'gpu' }),
    stallText: (seconds) => `сервер моделей ${seconds} с не двигался с запросом`,
    intervalMs: 20,
    stallMs: () => 300,
  });
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  gateway.setLocalUpstream((platformId) =>
    platformId === PLATFORM.id
      ? {
          context: 65_536,
          // Замер скорости «быстрой карты»: расчёт срока первого байта упёрся бы в пол.
          promptTokensPerSecond: 2_300,
          watch: (tokens: number) => watch.track(tokens),
          ...extra,
        }
      : undefined,
  );
  port = gateway.status().port;
}

function ask(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'qwen-local', max_tokens: 100, stream: true, ...body }),
    ...(signal ? { signal } : {}),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-review-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  upstreamSignals = [];
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  watch?.stop();
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('слой прогона против окна (ревью B1)', () => {
  it('запрос с инструментами: панель получает долю системного промпта и инструментов в счёте токенов', async () => {
    const layers: number[] = [];
    await start(upstream(10), { layer: (tokens) => layers.push(tokens) });
    const system = 'Ты агент панели. '.repeat(600);
    const tools = Array.from({ length: 20 }, (_, index) => ({
      name: `tool_${index}`,
      description: 'Делает полезное. '.repeat(40),
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }));
    const answer = await ask({ system, tools, messages: [{ role: 'user', content: 'привет' }] });
    expect(answer.status).toBe(200);
    await answer.text();
    expect(layers).toHaveLength(1);
    const layerChars = JSON.stringify(system).length + JSON.stringify(tools).length;
    // Счёт шлюза без выученного соотношения — 3 символа на токен; слой — почти весь запрос.
    expect(layers[0]).toBeGreaterThan(Math.round((layerChars / 3) * 0.95));
    expect(layers[0]).toBeLessThanOrEqual(Math.round(layerChars / 3) + 1);
  });

  it('запрос без инструментов (заголовок чата) слоя не несёт — панель его не получает', async () => {
    const layers: number[] = [];
    await start(upstream(10), { layer: (tokens) => layers.push(tokens) });
    const answer = await ask({
      system: 'Придумай заголовок.',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(answer.status).toBe(200);
    await answer.text();
    expect(layers).toEqual([]);
  });
});

describe('срок первого байта под присмотром (ревью M3)', () => {
  it('ставится страховочный срок, а не расчёт по замеру скорости (пол 300 с)', async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
      if (typeof ms === 'number') delays.push(ms);
      return real(callback, ms);
    }) as typeof setTimeout);
    await start(upstream(10));
    const answer = await ask({ messages: [{ role: 'user', content: 'привет' }] });
    expect(answer.status).toBe(200);
    await answer.text();
    expect(delays).toContain(LOCAL_WATCHED_FIRST_BYTE_MS);
    expect(delays).not.toContain(LOCAL_FIRST_TOKEN_FLOOR_MS);
  });
});

describe('клиент ушёл до начала присмотра (ревью m3)', () => {
  it('Esc во время подготовки: присмотр снимает запрос сразу — ни висящего запроса, ни ложного «обрыва»', async () => {
    const client = new AbortController();
    let prepared!: () => void;
    const preparing = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    await start(upstream(), {
      prepare: async () => {
        // Клиент уходит, пока шлюз ещё готовит запрос (сброс кеша слота, подъём сервера).
        client.abort();
        await new Promise((resolve) => setTimeout(resolve, 150));
        prepared();
      },
    });
    await ask({ messages: [{ role: 'user', content: 'привет' }] }, client.signal).catch(
      () => undefined,
    );
    await preparing;
    // Дольше срока тишины (300 мс): висящий запрос уже был бы оборван присмотром.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const snapshot = watch.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.lastStall).toBeUndefined();
    // Сервер моделей не считает ответ для ушедшего клиента.
    expect(upstreamSignals.every((signal) => signal.aborted)).toBe(true);
  });
});
