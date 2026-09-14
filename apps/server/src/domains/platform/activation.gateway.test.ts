import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { PlatformGateway } from './gateway/listener.ts';
import { activatePlatform, SMOKE_MAX_TOKENS, type ContourActivationDeps } from './activation.ts';
import { writePlatform, writeToken } from './store.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Пробный запрос активации — через НАСТОЯЩИЙ шлюз: настоящий сокет на петле,
 * настоящий конвейер, подставлен только контур наверху.
 *
 * Ради этого транспорты и разведены (`probeFetch` / `smokeFetch`): заглушка,
 * подставленная обоим, доказывала бы работу заглушки. Здесь же запрос выходит
 * из домена в сеть, возвращается в свой же слушатель, проходит перевод диалекта
 * и подстановку ключа — то есть ровно тот путь, которым пойдёт CLI, и ни одним
 * звеном короче.
 */

const SECRET = 'contour-key-corporate-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: false,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

/** Проба: список моделей прямо из контура, мимо шлюза. */
const modelsOk: PlatformFetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
/** Куда и с чем шлюз сходил наверх: адрес, заголовки, тело. */
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

/** Контур-заглушка НАД шлюзом: отвечает потоком, как настоящий. */
function upstream(frames: string[], status = 200): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (status >= 400) {
      return Promise.resolve(
        new Response(frames.join(''), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

const DELTA = '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"готов"}}]}';
const DONE = '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-activation-gw-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  calls = [];

  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

const deps = (): ContourActivationDeps => ({
  store,
  paths: { claudeSettings: join(root, 'claude', 'settings.json') },
  backupDir: join(root, 'backups'),
  appDataDir: appData,
  probeFetch: modelsOk,
  // Порт — у ЖИВОГО слушателя, ровно как его берёт маршрут: порт 0 при старте
  // означает «какой достанется», и спросить его можно только у него самого.
  gatewayPort: () => (gateway.status().running ? gateway.status().port : 0),
  // `smokeFetch` не задан НАМЕРЕННО: пробный запрос идёт настоящим `fetch` в
  // настоящий слушатель на 127.0.0.1.
});

describe('пробный запрос идёт через собственный шлюз', () => {
  it('ответ модели приезжает на карточку, а ключ подставляет шлюз', async () => {
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([DELTA, DONE]),
      spendFlushMs: 0,
    });

    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.answer).toBe('готов');
    expect(result.smoke.model).toBe('gpt-x');
    expect(result.smoke.latencyMs).toBeGreaterThanOrEqual(0);

    // Наверх ушёл ровно один запрос — на адрес контура, с ключом в заголовке.
    // Ключ в запросе домена не встречается вовсе: его добавил шлюз.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('api.dev.example.ru');
    expect(JSON.stringify(calls[0]?.headers)).toContain(SECRET);
    // Вопрос — тот, что объявил драйвер, и потолок ответа при нём.
    expect(calls[0]?.body).toContain('готов');
    expect(JSON.parse(calls[0]?.body ?? '{}').max_tokens).toBe(SMOKE_MAX_TOKENS);
  });

  /**
   * Живое подключение 14.09.2026: шлюз был погашен, активация закончилась
   * красным «Шлюз не поднят», а подъём жил только на последнем шаге мастера.
   * Настоящий слушатель поднимается САМОЙ активацией — и пробный запрос
   * проходит через него.
   */
  /**
   * Живое подключение dev 14.09.2026: Qwen3.8 пишет размышления текстом до голого
   * `</think>`, и карточка показывала черновик модели вместо ответа. Пробный
   * запрос — первый ответ модели через шлюз: по нему шлюз и запоминает факт.
   */
  it('размышление текстом не попадает на карточку, а шлюз запоминает модель', async () => {
    const thinking = (content: string): string =>
      JSON.stringify({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content } }] });
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([thinking('Нужно одно слово. </th'), thinking('ink>\n\n'), DELTA, DONE]),
      spendFlushMs: 0,
    });

    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.answer).toBe('готов');
    expect(store.getThinkTailModels(PLATFORM.id)).toEqual(['gpt-x']);
  });

  it('погашенный шлюз активация поднимает сама, и пробный запрос проходит', async () => {
    const result = await activatePlatform(
      {
        ...deps(),
        ensureGateway: async () => {
          await gateway.start({
            store,
            appDataDir: appData,
            port: 0,
            fetchImpl: upstream([DELTA, DONE]),
            spendFlushMs: 0,
          });
        },
      },
      PLATFORM.id,
    );
    expect(gateway.status().running).toBe(true);
    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.answer).toBe('готов');
  });

  it('шлюз не поднялся — причина в пробном запросе, активация остаётся', async () => {
    const result = await activatePlatform(
      { ...deps(), ensureGateway: () => Promise.reject(new Error('EADDRINUSE 5179')) },
      PLATFORM.id,
    );
    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toBe('Шлюз не поднялся: EADDRINUSE 5179');
    expect(store.getSettings().activePlatformId).toBe(PLATFORM.id);
  });

  it('контур отказал — отказ виден словами, активация остаётся', async () => {
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream(['{"error":{"message":"ключ отозван"}}'], 401),
      spendFlushMs: 0,
    });

    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toBeTruthy();
    expect(result.smoke.detail).not.toContain(SECRET);
    expect(store.getSettings().activePlatformId).toBe(PLATFORM.id);
  });

  it('модель промолчала — это не успех', async () => {
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([DONE]),
      spendFlushMs: 0,
    });

    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toContain('не сказала ни слова');
  });
});

/**
 * Аудит DRV-11. Контур отдаёт чат и эмбеддинги одним списком
 * (`handler_public_api.go:219-221`), а пробный запрос брал первую модель списка
 * мимо выбора человека и восемь токенов — которые reasoning-модель целиком
 * тратит на размышления (`chat/schemas.py:116-119`). Итог — красная карточка
 * у здорового контура.
 */
describe('пробный запрос спрашивает ту модель, которой пойдёт работа', () => {
  const catalog =
    (models: unknown[]): PlatformFetch =>
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: models }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  const smokeModel = () => JSON.parse(calls[0]?.body ?? '{}').model as string;

  it('выбор человека сильнее первой модели каталога', async () => {
    writePlatform(store, { ...PLATFORM, defaultModel: 'chat-picked' });
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([DELTA, DONE]),
      spendFlushMs: 0,
    });

    const probeFetch = catalog([
      { id: 'embed-first', type: 'embedding' },
      { id: 'chat-picked', type: 'chat' },
    ]);
    const result = await activatePlatform({ ...deps(), probeFetch }, PLATFORM.id);

    expect(result.smoke.model).toBe('chat-picked');
    expect(smokeModel()).toBe('chat-picked');
  });

  it('без выбора — первая ЧАТОВАЯ модель, а не эмбеддинг', async () => {
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([DELTA, DONE]),
      spendFlushMs: 0,
    });

    const probeFetch = catalog([
      { id: 'embed-first', type: 'embedding' },
      { id: 'chat-1', type: 'chat' },
    ]);
    const result = await activatePlatform({ ...deps(), probeFetch }, PLATFORM.id);

    expect(result.smoke.model).toBe('chat-1');
    expect(smokeModel()).toBe('chat-1');
  });

  it('потолок ответа оставляет место размышлениям, а упёршийся в него ответ назван', async () => {
    const LENGTH = '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}';
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([LENGTH]),
      spendFlushMs: 0,
    });

    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(SMOKE_MAX_TOKENS).toBeGreaterThanOrEqual(64);
    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toContain(`${SMOKE_MAX_TOKENS}`);
    expect(result.smoke.detail).toContain('размышлен');
  });
});
