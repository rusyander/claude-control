import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { PlatformFetch } from '../ca-fetch/ca-fetch.ts';
import {
  listeningGateway,
  memoryContours,
  type MemoryContours,
} from '../contours/__fixtures__/memory-contours.ts';
import {
  activatePlatform,
  switchPlatformOn,
  SMOKE_MAX_TOKENS,
  type ContourActivationDeps,
} from './activation.ts';
import { writePlatform, writeToken } from '../store/store.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Пробный запрос активации — настоящим `fetch` по сокету на петле в шлюз контуров. Шлюз держит
 * ядро (этап 10, C3d), здесь он — внешняя граница: сервер на 127.0.0.1, отвечающий так, как шлюз
 * человека отвечает клиенту Anthropic (`/<контур>/v1/messages`, поток). Порт панель берёт у учёта
 * контуров ядра (`memoryContours`: шлюз «слушает» на порту этого сервера).
 *
 * Транспорты разведены (`probeFetch` / `smokeFetch`): заглушка, подставленная обоим, доказывала
 * бы работу заглушки. Чего здесь нет и где оно доказано: перевод диалекта и подстановка ключа
 * контура — `apps/core/src/hop-host/user-gateway.parity.integration.test.ts`; память моделей с
 * голым `</think>` — `apps/core/src/hop-host/gateway/think-tail/think-tail.test.ts`; слушатель и
 * его порт — `apps/core/src/hop-host/user-gateway.integration.test.ts`.
 */

const SECRET = 'contour-key-corporate-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Company · dev',
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
let contours: MemoryContours;
let gateway: Server;
/** Что шлюз получил от панели: путь, заголовки, тело. */
let calls: { path: string; headers: Record<string, unknown>; body: string }[] = [];
/** Ответ шлюза: статус и кадры потока Anthropic (или тело отказа). */
let answer: { status: number; frames: string[] };

/** Кадр потока Anthropic, как его отдаёт шлюз человека клиенту `/v1/messages`. */
const text = (chunk: string): string =>
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: chunk },
  });
const stop = (reason: string): string =>
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-activation-gw-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  calls = [];
  answer = { status: 200, frames: [text('готов'), stop('end_turn')] };

  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);

  gateway = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      calls.push({ path: request.url ?? '', headers: { ...request.headers }, body: raw });
      if (answer.status >= 400) {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        return response.end(answer.frames.join(''));
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of answer.frames) response.write(`data: ${frame}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  contours = memoryContours();
});

afterEach(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** Шлюз человека у ядра слушает — на порту подставного шлюза. */
const listen = (): void =>
  contours.setUserGateway(listeningGateway((gateway.address() as AddressInfo).port));

const deps = (): ContourActivationDeps => ({
  store,
  paths: { claudeSettings: join(root, 'claude', 'settings.json') },
  backupDir: join(root, 'backups'),
  appDataDir: appData,
  probeFetch: modelsOk,
  // Порт — тот, что держит шлюз человека у ядра сейчас, ровно как его берёт маршрут.
  gatewayPort: () => contours.userGatewayPort(),
  // `smokeFetch` не задан НАМЕРЕННО: пробный запрос идёт настоящим `fetch` по сокету.
});

describe('пробный запрос идёт через шлюз контуров', () => {
  it('ответ модели приезжает на карточку; ключа контура в запросе панели нет — его подставляет шлюз', async () => {
    listen();
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.answer).toBe('готов');
    expect(result.smoke.model).toBe('gpt-x');
    expect(result.smoke.latencyMs).toBeGreaterThanOrEqual(0);

    // В шлюз ушёл ровно один запрос — по адресу контура, тем путём, которым пойдёт Claude Code.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/${PLATFORM.id}/v1/messages`);
    expect(JSON.stringify(calls[0]?.headers)).not.toContain(SECRET);
    expect(calls[0]?.body).not.toContain(SECRET);
    // Вопрос — тот, что объявил драйвер, и потолок ответа при нём.
    expect(calls[0]?.body).toContain('готов');
    const sent = JSON.parse(calls[0]?.body ?? '{}') as { max_tokens: number; stream: boolean };
    expect(sent.max_tokens).toBe(SMOKE_MAX_TOKENS);
    expect(sent.stream).toBe(true);
  });

  /**
   * Живое подключение dev 14.09.2026: Qwen3.8 пишет размышления текстом до голого
   * `</think>`, и карточка показывала черновик модели вместо ответа. Первый такой ответ шлюз
   * отдаёт целиком — карточке нужен ответ, а не черновик.
   */
  it('размышление текстом не попадает на карточку', async () => {
    answer = {
      status: 200,
      frames: [text('Нужно одно слово. </th'), text('ink>\n\n'), text('готов'), stop('end_turn')],
    };
    listen();
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.answer).toBe('готов');
  });

  /**
   * Живое подключение 14.09.2026: шлюз был погашен, активация закончилась красным «Шлюз не
   * поднят», а подъём жил только на последнем шаге мастера. Активация сама просит шлюз
   * (`ensureGateway` — свежий вопрос ядру) — и пробный запрос проходит через него.
   */
  it('шлюз не слушал — активация просит его сама, и пробный запрос проходит', async () => {
    const result = await activatePlatform(
      {
        ...deps(),
        ensureGateway: async () => {
          await contours.refresh();
          listen();
        },
      },
      PLATFORM.id,
    );
    expect(contours.refreshes).toBe(1);
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
    expect(calls).toHaveLength(0);
  });

  it('контур отказал — отказ виден словами, ключа в нём нет, активация остаётся', async () => {
    answer = { status: 401, frames: ['{"error":{"message":"ключ отозван"}}'] };
    listen();
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toBeTruthy();
    expect(result.smoke.detail).not.toContain(SECRET);
    expect(store.getSettings().activePlatformId).toBe(PLATFORM.id);
  });

  it('модель промолчала — это не успех', async () => {
    answer = { status: 200, frames: [stop('end_turn')] };
    listen();
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toContain('не сказала ни слова');
  });
});

/**
 * Аудит DRV-11. Контур отдаёт чат и эмбеддинги одним списком
 * (так отвечает его публичная часть), а пробный запрос брал первую модель списка
 * мимо выбора человека и восемь токенов — которые reasoning-модель целиком
 * тратит на размышления (так устроена схема запроса чата на стороне платформы).
 * Итог — красная карточка
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
    listen();
    const probeFetch = catalog([
      { id: 'embed-first', type: 'embedding' },
      { id: 'chat-picked', type: 'chat' },
    ]);
    const result = await activatePlatform({ ...deps(), probeFetch }, PLATFORM.id);

    expect(result.smoke.model).toBe('chat-picked');
    expect(smokeModel()).toBe('chat-picked');
  });

  it('без выбора — первая ЧАТОВАЯ модель, а не эмбеддинг', async () => {
    listen();
    const probeFetch = catalog([
      { id: 'embed-first', type: 'embedding' },
      { id: 'chat-1', type: 'chat' },
    ]);
    const result = await activatePlatform({ ...deps(), probeFetch }, PLATFORM.id);

    expect(result.smoke.model).toBe('chat-1');
    expect(smokeModel()).toBe('chat-1');
  });

  it('потолок ответа оставляет место размышлениям, а упёршийся в него ответ назван', async () => {
    answer = { status: 200, frames: [stop('max_tokens')] };
    listen();
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(SMOKE_MAX_TOKENS).toBeGreaterThanOrEqual(64);
    expect(result.smoke.ok).toBe(false);
    expect(result.smoke.detail).toContain(`${SMOKE_MAX_TOKENS}`);
    expect(result.smoke.detail).toContain('размышлен');
  });
});

describe('включение без пробы (кнопка локальной модели в шапке чата)', () => {
  it('контур активен, шлюз спрошен, а в шлюз не ушло ни одного запроса и итог пробы не тронут', async () => {
    let probed = 0;
    const result = await switchPlatformOn(
      {
        ...deps(),
        probeFetch: (...args) => {
          probed += 1;
          return modelsOk(...args);
        },
        ensureGateway: async () => {
          await contours.refresh();
          listen();
        },
      },
      PLATFORM.id,
    );

    expect(result).toEqual({ activePlatformId: PLATFORM.id, previousPlatformId: '' });
    expect(store.getSettings().activePlatformId).toBe(PLATFORM.id);
    expect(contours.refreshes).toBe(1);
    expect(probed).toBe(0);
    expect(calls).toHaveLength(0);
    expect(store.getPlatformSmoke()[PLATFORM.id]).toBeUndefined();
  });

  it('шлюз не поднялся — контур всё равно активен, причина в ответе', async () => {
    const result = await switchPlatformOn(
      {
        ...deps(),
        ensureGateway: () => Promise.reject(new Error('порт 5179 занят')),
      },
      PLATFORM.id,
    );
    expect(result.gatewayError).toBe('порт 5179 занят');
    expect(store.getSettings().activePlatformId).toBe(PLATFORM.id);
  });
});
