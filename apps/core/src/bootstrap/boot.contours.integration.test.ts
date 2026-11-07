import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CoreContourNoticesReply,
  CoreContourRunReply,
  CoreContoursReply,
  CoreContourSummarizedReply,
} from '@agentdeck/contracts/core/hops';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import { startContourStub, type ContourStub } from '@agentdeck/stub-model/scenarios/contour';
import { startHopHost, type RunningHopHost } from '../hop-host/host.ts';
import { CONTOUR_SPEND_FILE } from '../hop-host/contour-book/contour-book.ts';
import { tempDir } from '../journal/__fixtures__/journal-harness.ts';
import { contourStoreId } from '../routes/gateway/gateway.ts';
import { bootCore, type BootedCore } from './boot.ts';

/**
 * Учёт контуров на НАСТОЯЩЕЙ загрузке ядра (C3b): запрос CLI → шлюз ядра на хосте звеньев →
 * стаб-контур (`@agentdeck/stub-model/scenarios/contour`, тот же провод, что у свипов панели) →
 * книга контуров → файл учёта; читает API ядра → порт → протокол управления хоста. Учёт засевает
 * только трафик звена — записи снаружи нет, так что чтения ниже идут по той же дороге, что пишет
 * учёт в работе. Контуры и бюджет — из `state.json` временного каталога панели, ключ — в её
 * хранилище.
 */

const j = (...parts: string[]): string => parts.join('');
const CONTOUR_KEY = j('sk-', 'contour', '-spend-0123456789');
/** Кадр расхода стаба: 11 входа + 2 выхода = 13 токенов. */
const TOKENS = 13;
/** 11 × 0.05 $ + 2 × 0.2 $ за тысячу → 0.95 $ запрос: порог внимания (90 % из 1 $), не бюджет. */
const PER_REQUEST_USD = 0.95;

let stub: ContourStub;
let core: BootedCore | undefined;
let host: RunningHopHost;
let appData: string;
let auth: Record<string, string>;
let gatewayPort: number;

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${core!.url}${path}`, {
    method,
    headers: {
      ...auth,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as T };
}

/** Запрос CLI через шлюз ядра — единственный писатель учёта контуров. */
async function through(
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'cli-placeholder' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Инструмент агента: контур схем не принимает, прослойка звена кладёт его в текст запроса, а
 * `stub-tool-shim` отвечает одним вызовом `<tool_call>` — звено разбирает его обратно.
 */
const WRITE_TOOL = {
  type: 'function',
  function: {
    name: 'Write',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
};

const chat = (model: string, runTag?: string, tools?: unknown[]) =>
  through(`/dev${runTag ? `/_run/${runTag}` : ''}/v1/chat/completions`, {
    model,
    stream: true,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'привет' }],
    ...(tools ? { tools } : {}),
  });

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!ok(last) && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 50));
    last = await read();
  }
  return last;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

beforeAll(async () => {
  stub = await startContourStub({ port: 0 });
  appData = tempDir('contours-panel-');
  writeFileSync(
    join(appData, 'state.json'),
    JSON.stringify({
      settings: {
        platforms: [
          {
            id: 'dev',
            title: 'Company · dev',
            driver: 'enterprise-platform',
            baseUrl: stub.url,
            enabled: true,
            budgetUsd: 1,
            // Прослойка инструментов: вызовы агента в прогоне чужого CLI считает звено.
            toolShim: true,
          },
        ],
        modelPricing: {
          'stub-chat': { input: 50_000, output: 200_000, cacheRead: 0, cacheWrite: 0 },
        },
      },
    }),
  );
  setStoredKey(appData, contourStoreId('dev'), CONTOUR_KEY);
  // Журнал сжатий, который вела панель до C3b: звено забирает его при первом запуске.
  writeFileSync(
    join(appData, 'platform-summarized.json'),
    JSON.stringify([
      {
        at: '2026-10-01T00:00:00.000Z',
        platformId: 'dev',
        path: '/dev/v1/messages',
        messageId: 'msg_legacy',
      },
    ]),
  );
  gatewayPort = await freePort();
  const home = join(tempDir('contours-core-'), 'core');
  // Хост звеньев этого дома — в процессе теста и ДО ядра: такт ядра находит его по `procs.json`.
  host = await startHopHost({ home, panelAppData: appData, retryPauseMs: 10 });
  core = await bootCore({
    home,
    build: 'contours-test',
    panelAppData: appData,
    loop: false,
    userGateway: { port: gatewayPort, intervalMs: 200 },
  });
  auth = { authorization: `Bearer ${readFileSync(core.layout.token, 'utf8').trim()}` };
  const listening = await until(
    () => api<CoreContoursReply>('GET', '/v1/contours'),
    (reply) => reply.json.userGateway?.state === 'listening',
    10_000,
  );
  if (listening.json.userGateway?.state !== 'listening')
    throw new Error(`шлюз ядра не слушает: ${JSON.stringify(listening.json.userGateway)}`);
}, 60_000);

afterAll(async () => {
  await core?.stop().catch(() => undefined);
  await host?.close();
  await stub?.close();
});

describe('учёт контуров через API ядра, засев — трафиком шлюза ядра', () => {
  it('запрос через шлюз ядра ложится днём с деньгами, след и счётчик видны в карточке', async () => {
    const sent = await chat('stub-chat');
    expect(sent.status).toBe(200);
    // Ключ контура подставило звено: учёт пишет именно этот, настоящий проход.
    expect(stub.calls.at(-1)?.authorization).toContain(CONTOUR_KEY);

    const { status, json } = await until(
      () => api<CoreContoursReply>('GET', '/v1/contours'),
      (reply) => (reply.json.records?.dev?.days?.[0]?.totalTokens ?? 0) > 0,
    );
    expect(status).toBe(200);
    // Путь — за префиксом контура: контур назван полем `platformId`.
    expect(json.live.events[0]).toMatchObject({
      platformId: 'dev',
      path: '/v1/chat/completions',
      status: 200,
      totalTokens: TOKENS,
    });
    expect(json.live.usage).toEqual([
      expect.objectContaining({ platformId: 'dev', totalTokens: TOKENS }),
    ]);
    const day = json.records.dev!.days[0]!;
    expect(day.totalTokens).toBe(TOKENS);
    // Цена человека из каталога панели: 11 входа и 2 выхода по ценам `stub-chat`.
    expect(day.money.usd).toBeCloseTo(PER_REQUEST_USD, 9);
    // Файл учёта — в каталоге состояния хоста звеньев, а не у панели.
    const file = join(host.ctx.stateDir, CONTOUR_SPEND_FILE);
    const stored = await until(
      async () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
      (value) => value?.records?.dev !== undefined,
    );
    expect(stored?.records?.dev).toBeDefined();
  });

  it('порог внимания (90 % из 1 $) звучит извещением по курсору, второй раз — нет', async () => {
    const first = await until(
      () => api<CoreContourNoticesReply>('GET', '/v1/contours/notices?after=0'),
      (reply) => reply.json.notices?.length > 0,
    );
    expect(first.status).toBe(200);
    expect(first.json.notices).toEqual([
      expect.objectContaining({
        seq: 1,
        platformId: 'dev',
        platformTitle: 'Company · dev',
        level: 'near',
      }),
    ]);
    const after = await api<CoreContourNoticesReply>('GET', '/v1/contours/notices?after=1');
    expect(after.json.notices).toEqual([]);
    expect((await api('GET', '/v1/contours/notices?after=-1')).status).toBe(400);
  });

  it('отказ 402 контура ставит отметку, снятие убирает её; повтор — «снимать нечего»', async () => {
    expect((await chat('stub-402')).status).toBe(402);
    const marked = await until(
      () => api<CoreContoursReply>('GET', '/v1/contours'),
      (reply) => reply.json.records?.dev?.exhaustedScope !== undefined,
    );
    // Стаб отвечает дословным текстом платформы «budget exceeded for this API key».
    expect(marked.json.records.dev).toMatchObject({ exhaustedScope: 'key' });
    expect(marked.json.live.events[0]).toMatchObject({ platformId: 'dev', status: 402 });
    expect(marked.json.live.failures).toBeGreaterThanOrEqual(1);

    const cleared = await api<{ cleared: boolean }>('POST', '/v1/contours/dev/clear-exhausted');
    expect(cleared.json.cleared).toBe(true);
    const after = await api<CoreContoursReply>('GET', '/v1/contours');
    expect(after.json.records.dev).not.toHaveProperty('exhaustedAt');
    expect(
      (await api<{ cleared: boolean }>('POST', '/v1/contours/dev/clear-exhausted')).json.cleared,
    ).toBe(false);
    // Снятие пишет и без тела, но не без токена.
    const anonymous = await fetch(`${core!.url}/v1/contours/dev/clear-exhausted`, {
      method: 'POST',
    });
    expect(anonymous.status).toBe(401);
  });

  it('прогон чужого CLI: сжатие по метке и вызовы инструментов с начала прогона', async () => {
    const since = Date.now();
    expect((await chat('stub-summarizing', 'run-a')).status).toBe(200);
    const called = await chat('stub-tool-shim', 'run-a', [WRITE_TOOL]);
    expect(called.status).toBe(200);
    // Клиент получил вызов полем `tool_calls`, а не текстом прослойки.
    expect(called.text).toContain('"tool_calls"');
    expect(called.text).not.toContain('<tool_call>');

    const run = await until(
      () => api<CoreContourRunReply>('GET', `/v1/contours/run?tag=run-a&since=${since}`),
      (reply) => reply.json.summarized === true && reply.json.toolCalls !== undefined,
    );
    expect(run.status).toBe(200);
    // Запросы до `since` не считаются: только один вызов прослойкой во втором запросе прогона.
    expect(run.json).toEqual({ summarized: true, toolCalls: 1 });
    const other = await api<CoreContourRunReply>(
      'GET',
      `/v1/contours/run?tag=run-b&since=${since + 60_000}`,
    );
    // Чужая метка не сжималась, а запросов после `since` не было — поля вызовов нет вовсе.
    expect(other.json).toEqual({ summarized: false });

    expect((await api('GET', '/v1/contours/run?tag=a%20b&since=0')).status).toBe(400);
    expect((await api('GET', '/v1/contours/run?tag=run-a&since=-5')).status).toBe(400);
    expect((await api('GET', '/v1/contours/run?tag=run-a')).status).toBe(400);
  });

  it('сжатие перед ответом Claude: id, выданный шлюзом клиенту Anthropic, ложится за старым журналом', async () => {
    const sent = await through('/dev/v1/messages', {
      model: 'stub-summarizing',
      max_tokens: 16,
      stream: false,
      messages: [{ role: 'user', content: 'длинный разговор' }],
    });
    expect(sent.status).toBe(200);
    const messageId = (JSON.parse(sent.text) as { id?: string }).id;
    expect(messageId).toMatch(/^msg_/);

    const ids = await until(
      () => api<CoreContourSummarizedReply>('GET', '/v1/contours/summarized'),
      (reply) => reply.json.messageIds?.length > 1,
    );
    expect(ids.status).toBe(200);
    // Подпись старого ответа (журнал панели) пережила переезд, новая легла за ней.
    expect(ids.json.messageIds).toEqual(['msg_legacy', messageId]);
  });
});
