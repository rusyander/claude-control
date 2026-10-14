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

/**
 * Окно локальной модели на настоящем пути шлюза (L1): слушатель, настоящий HTTP
 * от «CLI», подменён только ответ сервера моделей.
 *
 * Правила, которые Claude Code применяет к отказу, взяты из его бинаря 2.1.286
 * (`AWn` — «prompt is too long» в сообщении при статусе 400; `xst` — числа
 * `N tokens > M`) и повторены здесь регулярками: тест краснеет, если отказ шлюза
 * перестаёт быть тем, что CLI узнаёт.
 */

const PLATFORM: Platform = {
  id: 'local-window-test',
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

const CONTEXT = 8_192;
const driver = driverFor('enterprise-platform');
const declared = { ...driver };

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls = 0;

function sse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

/** Поток сообщения: `input` — вход, который насчитал «сервер», `output` — выход. */
function stream(stop: string, input: number, output: number): string {
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'qwen-local',
          content: [],
          usage: { input_tokens: input, output_tokens: 1 },
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
      { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: output } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function serverAnswers(text: string): PlatformFetch {
  return (url) => {
    // Счёт токенов (точный счёт у порога окна) — не запрос чата: считаются только ответы.
    if (String(url).endsWith('/count_tokens'))
      return Promise.resolve(new Response('{}', { status: 404 }));
    calls += 1;
    return Promise.resolve(
      new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

async function start(fetchImpl: PlatformFetch, local = true): Promise<void> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  if (local) {
    gateway.setLocalUpstream((platformId) =>
      platformId === PLATFORM.id ? { context: CONTEXT, promptTokensPerSecond: 200 } : undefined,
    );
  }
  port = gateway.status().port;
}

function ask(text: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'qwen-local',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-window-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  calls = 0;
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('запрос не влезает в окно локальной модели', () => {
  it('шлюз отказывает текстом, по которому Claude Code сжимает историю, и до сервера не доходит', async () => {
    await start(serverAnswers(stream('end_turn', 10, 5)));
    // 60 тысяч символов — по запасной прикидке 3 символа на токен это 20 тысяч токенов при окне 8192.
    const answer = await ask('x'.repeat(60_000));
    const body = (await answer.json()) as {
      type: string;
      error: { type: string; message: string };
    };

    expect(answer.status).toBe(400);
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('invalid_request_error');
    // Правило CLI (`AWn`): сообщение содержит «prompt is too long» при статусе 400.
    expect(body.error.message.toLowerCase()).toContain('prompt is too long');
    // Числа читает `xst`: «N tokens > M»; M — окно за вычетом запаса под ответ.
    const numbers = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(
      body.error.message,
    );
    expect(numbers).not.toBeNull();
    expect(Number(numbers?.[2])).toBe(CONTEXT - 4_096);
    expect(Number(numbers?.[1])).toBeGreaterThan(CONTEXT - 4_096);
    expect(calls).toBe(0);
    expect(gateway.status().events[0]).toMatchObject({ status: 400 });
  });

  it('запрос, который влезает, уходит на сервер и поток доезжает как есть', async () => {
    const upstream = stream('end_turn', 100, 5);
    await start(serverAnswers(upstream));
    const answer = await ask('привет');

    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(upstream);
    expect(calls).toBe(1);
  });

  it('не локальный контур: тот же большой запрос идёт как раньше', async () => {
    await start(serverAnswers(stream('end_turn', 10, 5)), false);
    const answer = await ask('x'.repeat(60_000));
    expect(answer.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('счёт токенов выучивается по настоящему ответу: плотный текст перестаёт занижаться', async () => {
    // Запасная прикидка (3 символа на токен) пропускает 7000 символов: ~2400 токенов.
    // Сервер насчитал в них 5000 — следующий запрос того же размера уже не влезает.
    await start(serverAnswers(stream('end_turn', 5_000, 5)));
    const first = await ask('я'.repeat(7_000));
    expect(first.status).toBe(200);
    await first.text();
    const second = await ask('я'.repeat(7_000));
    expect(second.status).toBe(400);
    expect(calls).toBe(1);
  });
});

describe('подготовка сервера перед запросом (сброс кеша при смене разговора)', () => {
  /** Запрос Claude Code с меткой разговора: `metadata.user_id` — JSON-строка (замер 14.10, claude 2.1.286). */
  function askAs(sessionId: string, text = 'привет'): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'qwen-local',
        max_tokens: 100,
        stream: true,
        metadata: {
          user_id: JSON.stringify({ device_id: 'd', account_uuid: '', session_id: sessionId }),
        },
        messages: [{ role: 'user', content: text }],
      }),
    });
  }

  it('разговор из metadata.user_id доходит до подготовки ДО обращения к серверу моделей', async () => {
    const order: string[] = [];
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: () => {
        order.push('server');
        return Promise.resolve(
          new Response(stream('end_turn', 10, 5), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        );
      },
      spendFlushMs: 0,
    });
    gateway.setLocalUpstream((platformId) =>
      platformId === PLATFORM.id
        ? {
            context: CONTEXT,
            prepare: (session) => {
              order.push(`prepare:${session}`);
              return Promise.resolve();
            },
          }
        : undefined,
    );
    port = gateway.status().port;
    await (await askAs('chat-A')).text();
    expect(order).toEqual(['prepare:chat-A', 'server']);
  });

  it('запрос, который не влезает в окно, отказом не доходит ни до подготовки, ни до сервера', async () => {
    const seen: (string | undefined)[] = [];
    await start(serverAnswers(stream('end_turn', 10, 5)));
    gateway.setLocalUpstream((platformId) =>
      platformId === PLATFORM.id
        ? {
            context: CONTEXT,
            prepare: (session) => {
              seen.push(session);
              return Promise.resolve();
            },
          }
        : undefined,
    );
    expect((await askAs('chat-A', 'x'.repeat(60_000))).status).toBe(400);
    expect(seen).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('ответ оборвался на пределе окна', () => {
  it('«length» вплотную к окну заменяется отказом переполнения, а не «превышен предел вывода»', async () => {
    await start(serverAnswers(stream('max_tokens', 3_900, 4_291)));
    const answer = await ask('привет');
    const text = await answer.text();

    expect(text).toContain('event: error');
    expect(text).toContain('prompt is too long');
    expect(text).not.toContain('max_tokens');
    expect(text).not.toContain('message_stop');
    // Текст ответа, дошедший до обрыва, остаётся: он уже ушёл клиенту.
    expect(text).toContain('ответ');
  });

  it('настоящий предел вывода при коротком ответе — поток без изменений', async () => {
    const upstream = stream('max_tokens', 300, 100);
    await start(serverAnswers(upstream));
    const answer = await ask('привет');
    expect(await answer.text()).toBe(upstream);
  });
});

describe('ожидание первого байта', () => {
  /** Какие сроки поставил шлюз: сюда попадают только долгие — собственный таймер заголовков. */
  function timerDelays(): number[] {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: Parameters<typeof setTimeout>[0],
      delay?: number,
      ...rest: unknown[]
    ) => {
      if (typeof delay === 'number' && delay >= 50_000) delays.push(delay);
      return real(handler as () => void, delay, ...(rest as []));
    }) as typeof setTimeout);
    return delays;
  }

  it('локальная модель получает не меньше пяти минут вместо минуты облачного контура', async () => {
    const delays = timerDelays();
    await start(serverAnswers(stream('end_turn', 10, 5)));
    await (await ask('привет')).text();
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(300_000);
  });

  it('не локальный контур — прежняя минута', async () => {
    const delays = timerDelays();
    await start(serverAnswers(stream('end_turn', 10, 5)), false);
    await (await ask('привет')).text();
    expect(Math.max(...delays)).toBe(60_000);
  });
});

describe('счёт токенов (/v1/messages/count_tokens)', () => {
  function count(text: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'qwen-local',
        messages: [{ role: 'user', content: text }],
      }),
    });
  }

  it('сервер считает сам — шлюз отдаёт его число и ходит на его ручку счёта, а не чата', async () => {
    const urls: string[] = [];
    await start(((url: string | URL | Request) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ input_tokens: 1234 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as PlatformFetch);
    const answer = await count('привет');

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ input_tokens: 1234 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/messages\/count_tokens$/);
  });

  it('сервер ручки не знает (404) — прикидка шлюза по символам, а не отказ', async () => {
    await start((() => Promise.resolve(new Response('{}', { status: 404 }))) as PlatformFetch);
    const answer = await count('x'.repeat(3_000));
    const body = (await answer.json()) as { input_tokens: number };

    expect(answer.status).toBe(200);
    // Запасная прикидка: 3 символа на токен, тело чуть длиннее самого текста.
    expect(body.input_tokens).toBeGreaterThan(1_000);
    expect(body.input_tokens).toBeLessThan(1_200);
  });

  it('сервер не отвечает — тоже прикидка', async () => {
    await start((() => Promise.reject(new Error('ECONNREFUSED'))) as PlatformFetch);
    const answer = await count('привет');
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0);
  });

  it('не локальный контур — по-прежнему 404, чужому шлюзу счёт не навязывается', async () => {
    await start(serverAnswers(stream('end_turn', 10, 5)), false);
    const answer = await count('привет');
    expect(answer.status).toBe(404);
    expect(calls).toBe(0);
  });
});
