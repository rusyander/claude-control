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
import { activatePlatform, type ContourActivationDeps } from './activation.ts';
import { findPlatform, writePlatform, writeToken } from '../store/store.ts';
import { shimFromProbe } from '../smoke-tools.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Проба инструментов (развилка 3) — настоящим `fetch` по сокету на петле в шлюз контуров. Шлюз
 * держит ядро (этап 10, C3d), здесь он — внешняя граница: сервер на 127.0.0.1, отвечающий потоком
 * Anthropic так, как шлюз человека отвечает клиенту `/<контур>/v1/messages`; порт панель берёт у
 * учёта контуров ядра (`memoryContours`).
 *
 * Чего здесь нет и где оно доказано: перевод поля `tools` в диалект контура —
 * `apps/core/src/hop-host/gateway/dialect/dialect.test.ts`, кадры вызова обратно —
 * `gateway/frames/frames.toolevents.test.ts`; подстановка ключа —
 * `apps/core/src/hop-host/user-gateway.parity.integration.test.ts`; слушатель и его порт —
 * `apps/core/src/hop-host/user-gateway.integration.test.ts`.
 */

const SECRET = 'contour-key-corporate-4f21';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Company · dev',
  driver: 'openai-compat',
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
  toolShim: false,
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
/** Что шлюз получил от панели: путь и тело. */
let calls: { path: string; body: string }[] = [];
/** Ответы шлюза по порядку запросов (последний — всем дальше): статус и кадры потока Anthropic. */
let answers: { status: number; frames: string[] }[];

/** Кадры потока Anthropic, как их отдаёт шлюз человека клиенту `/v1/messages`. */
const text = (chunk: string): string =>
  JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: chunk },
  });
const stop = (reason: string): string =>
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: reason } });
const CALL = JSON.stringify({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'tool_use', id: 't1', name: 'report_status', input: {} },
});
const ARGS = JSON.stringify({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'input_json_delta', partial_json: '{"status":"ready"}' },
});

const OK = { status: 200, frames: [text('готов'), stop('end_turn')] };
const CALLED = { status: 200, frames: [CALL, ARGS, stop('tool_use')] };
const said = (chunk: string) => ({ status: 200, frames: [text(chunk), stop('end_turn')] });

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-activation-tools-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  mkdirSync(join(root, 'claude'), { recursive: true });
  calls = [];
  answers = [OK];

  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);

  gateway = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      const answer = answers[Math.min(calls.length, answers.length - 1)] ?? OK;
      calls.push({ path: request.url ?? '', body: raw });
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
  // Шлюз человека у ядра слушает — на порту подставного шлюза.
  contours.setUserGateway(listeningGateway((gateway.address() as AddressInfo).port));
});

afterEach(async () => {
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

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

describe('проба инструментов при активации', () => {
  it('модель вызвала инструмент полем — зелёная строка, поле ушло в шлюз', async () => {
    answers = [OK, CALLED];
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.tools).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe(`/${PLATFORM.id}/v1/messages`);
    expect(JSON.parse(calls[1]?.body ?? '{}').tools?.[0]?.name).toBe('report_status');
    expect(calls[1]?.body).not.toContain(SECRET);
    expect(store.getState().platformSmoke?.[PLATFORM.id]?.tools).toEqual({ ok: true });
  });

  it('вызов текстом — причина названа, ничего не исполнено', async () => {
    const asText = '```json\n{"name":"report_status","arguments":{"status":"ready"}}\n```';
    answers = [OK, said(asText)];
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.ok).toBe(true);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'call-as-text' });
  });

  it('ответ без вызова — «не вызвала»', async () => {
    answers = [OK, said('Готово.')];
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'no-call' });
  });

  it('прослойка включена — не спрашиваем: один запрос в шлюз', async () => {
    writePlatform(store, { ...PLATFORM, toolShim: true });
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('тип контура выбрасывает поле — «dropped» без похода в сеть', async () => {
    writePlatform(store, { ...PLATFORM, driver: 'enterprise-platform' });
    const result = await activatePlatform(deps(), PLATFORM.id);
    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'dropped' });
    expect(calls).toHaveLength(1);
  });
});

/**
 * Умолчание прослойки по итогу пробы (развилка 3, решение В1). Проверяется по
 * ЗАПИСАННОМУ контуру, а не по ответу активации: тумблер живёт в состоянии, и
 * именно оттуда его читают конвейер и карточка.
 */
describe('прослойка по итогу пробы', () => {
  const saved = (): Platform => findPlatform(store, PLATFORM.id) as Platform;

  it('модель не вызвала инструмент — панель включает прослойку сама и отмечает, что это она', async () => {
    answers = [OK, said('Готово.')];
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(saved().toolShim).toBe(true);
    expect(saved().toolShimFromProbe).toBe(result.smoke.at);
  });

  it('вызов пришёл полем — тумблер остаётся человеческим, отметки нет', async () => {
    answers = [OK, CALLED];
    await activatePlatform(deps(), PLATFORM.id);

    expect(saved().toolShim).toBe(false);
    expect(saved().toolShimFromProbe).toBeUndefined();
  });

  it('человек выключил включённое панелью — вторая активация не возвращает своё', async () => {
    writePlatform(store, {
      ...PLATFORM,
      toolShim: false,
      toolShimFromProbe: '2026-09-19T10:00:00.000Z',
    });
    answers = [OK, said('Готово.')];
    await activatePlatform(deps(), PLATFORM.id);

    expect(saved().toolShim).toBe(false);
    expect(saved().toolShimFromProbe).toBe('2026-09-19T10:00:00.000Z');
  });

  it('запрос с инструментом отклонён — это сказано про запрос, а не про модель: тумблер не трогаем', async () => {
    // Первый запрос — живой ответ потоком, второй (с инструментом) — отказ шлюза.
    answers = [OK, { status: 503, frames: ['{"error":{"message":"upstream busy"}}'] }];
    const result = await activatePlatform(deps(), PLATFORM.id);

    expect(result.smoke.tools).toMatchObject({ ok: false, reason: 'refused' });
    expect(saved().toolShim).toBe(false);
    expect(saved().toolShimFromProbe).toBeUndefined();
  });

  it('свои инструменты платформы запирают решение: прослойка с ними — запрещённое сочетание', () => {
    const withTools = {
      ...PLATFORM,
      rules: {
        ...PLATFORM.rules,
        platform: { ...PLATFORM.rules.platform, platformTools: ['web_search'] },
      },
    };
    expect(shimFromProbe(withTools, { ok: false, reason: 'no-call' })).toBe(false);
    expect(shimFromProbe(PLATFORM, { ok: false, reason: 'no-call' })).toBe(true);
  });
});
