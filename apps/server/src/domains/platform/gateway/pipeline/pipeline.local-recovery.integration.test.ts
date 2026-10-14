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
import type { LocalUpstreamInfo } from '../local-window/local-window.ts';

/**
 * Локальная модель не должна умирать на ночном прогоне (L4b): отказ llama-server «не влезает
 * в окно», точный счёт у порога окна, `max_tokens`, который Claude Code уменьшает сам, и
 * упавший сервер, который шлюз просит поднять и не сдаётся 502. Настоящий путь: слушатель и
 * HTTP «CLI»; подменён только ответ сервера моделей. Тексты, по которым Claude Code узнаёт
 * отказ, — из его бинаря 2.1.286 (`AWn`, `oPr`/`vse`) и повторены регулярками.
 */

const PLATFORM: Platform = {
  id: 'local-recovery-test',
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
let chatCalls = 0;

function sse(events: Array<[string, unknown]>, finish = true): string {
  const all = finish ? events : events.slice(0, -1);
  return all.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Поток ответа; `finish: false` — сервер убит посреди ответа, `message_stop` не пришёл. */
function stream(finish = true): string {
  return sse(
    [
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
    ],
    finish,
  );
}

const refused = (): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11435'), {
      code: 'ECONNREFUSED',
    }),
  });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const eventStream = (text: string): Response =>
  new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });

/**
 * `raw` — заглушка сама отвечает и на счёт токенов; иначе счёт получает 404 (оценка
 * остаётся), и в `chatCalls` попадают только запросы чата.
 */
async function start(
  upstream: PlatformFetch,
  local: Partial<LocalUpstreamInfo> | false = {},
  raw = false,
) {
  const fetchImpl: PlatformFetch = (url, init) =>
    !raw && String(url).endsWith('/count_tokens')
      ? Promise.resolve(new Response('{}', { status: 404 }))
      : upstream(url, init);
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  if (local) {
    gateway.setLocalUpstream((platformId) =>
      platformId === PLATFORM.id
        ? { context: CONTEXT, promptTokensPerSecond: 200, ...local }
        : undefined,
    );
  }
  port = gateway.status().port;
}

function ask(text: string, maxTokens = 100): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'qwen-local',
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  });
}

interface ErrorBody {
  type: string;
  error: { type: string; message: string };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-recovery-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  chatCalls = 0;
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('отказ llama-server «не влезает в окно» превращается в то, что Claude Code узнаёт', () => {
  const llamaOverflow = {
    error: {
      code: 400,
      type: 'exceed_context_size_error',
      message:
        'request (9001 tokens) exceeds the available context size (8192 tokens), try increasing it',
      n_prompt_tokens: 9001,
      n_ctx: 8192,
    },
  };

  it('400 сервера → «prompt is too long: N tokens > M» с числами окна, а не «Контур не принял запрос»', async () => {
    await start(() => {
      chatCalls += 1;
      return Promise.resolve(json(400, llamaOverflow));
    });
    const answer = await ask('привет');
    const body = (await answer.json()) as ErrorBody;

    expect(answer.status).toBe(400);
    expect(body.error.message.toLowerCase()).toContain('prompt is too long');
    const numbers = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(
      body.error.message,
    );
    expect(Number(numbers?.[1])).toBe(9001);
    expect(Number(numbers?.[2])).toBe(8192 - 4_096);
    expect(chatCalls).toBe(1);
  });

  it('текст без полей n_prompt_tokens (старая сборка) тоже узнаётся по фразе', async () => {
    await start(() =>
      Promise.resolve(
        json(400, {
          error: {
            message:
              'request (9001 tokens) exceeds the available context size (8192 tokens), try increasing it',
          },
        }),
      ),
    );
    const body = (await (await ask('привет')).json()) as ErrorBody;
    expect(body.error.message).toMatch(/prompt is too long: 9001 tokens > 4096 maximum/);
  });

  it('чужой 400 локального сервера остаётся обычным отказом', async () => {
    await start(() => Promise.resolve(json(400, { error: { message: 'bad json' } })));
    const answer = await ask('привет');
    const body = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(400);
    expect(body.error.message.toLowerCase()).not.toContain('prompt is too long');
  });

  it('не локальный контур: тот же 400 переводу не подвергается', async () => {
    await start(() => Promise.resolve(json(400, llamaOverflow)), false);
    const body = (await (await ask('привет')).json()) as ErrorBody;
    expect(body.error.message.toLowerCase()).not.toContain('prompt is too long');
  });
});

describe('точный счёт у порога окна', () => {
  /** 9000 символов: оценка 3 символа на токен — ~3000, а с запасом под ответ это выше 75% окна. */
  const dense = 'x'.repeat(9_000);

  function serverCounting(counted: number): PlatformFetch {
    return (url) => {
      if (String(url).endsWith('/count_tokens'))
        return Promise.resolve(json(200, { input_tokens: counted }));
      chatCalls += 1;
      return Promise.resolve(eventStream(stream()));
    };
  }

  it('оценка промахнулась (плотный вывод), сервер насчитал больше — отказ до запроса', async () => {
    await start(serverCounting(4_600), {}, true);
    const answer = await ask(dense);
    expect(answer.status).toBe(400);
    const body = (await answer.json()) as ErrorBody;
    expect(body.error.message).toMatch(/prompt is too long: 4600 tokens > 4096 maximum/);
    expect(chatCalls).toBe(0);
  });

  it('сервер насчитал меньше оценки — запрос идёт, а не отказывается по завышенной оценке', async () => {
    await start(serverCounting(1_000), {}, true);
    const answer = await ask(dense);
    expect(answer.status).toBe(200);
    expect(chatCalls).toBe(1);
  });

  it('счёт не отвечает — остаётся оценка, запрос идёт', async () => {
    await start(
      (url) => {
        if (String(url).endsWith('/count_tokens')) return Promise.reject(new Error('down'));
        chatCalls += 1;
        return Promise.resolve(eventStream(stream()));
      },
      {},
      true,
    );
    expect((await ask(dense)).status).toBe(200);
    expect(chatCalls).toBe(1);
  });

  it('малый запрос счёта не просит: ниже 75% окна верим оценке', async () => {
    const urls: string[] = [];
    await start(
      (url) => {
        urls.push(String(url));
        chatCalls += 1;
        return Promise.resolve(eventStream(stream()));
      },
      {},
      true,
    );
    await (await ask('привет')).text();
    expect(urls.some((url) => url.endsWith('/count_tokens'))).toBe(false);
  });
});

describe('вход влезает, а вход плюс max_tokens — нет', () => {
  const body = 'x'.repeat(10_500);

  it('отказ текстом, который Claude Code разбирает сам и уменьшает max_tokens', async () => {
    await start(() => {
      chatCalls += 1;
      return Promise.resolve(eventStream(stream()));
    });
    const answer = await ask(body, 5_000);
    const parsed = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(400);
    // Правило CLI 2.1.286 (`oPr` + `vse`): подстрока и три числа «X + Y > Z».
    expect(parsed.error.message.toLowerCase()).toContain(
      'input length and `max_tokens` exceed context limit',
    );
    const numbers = /exceed context limit: (\d+) \+ (\d+) > (\d+)/.exec(parsed.error.message);
    expect(Number(numbers?.[2])).toBe(5_000);
    expect(Number(numbers?.[3])).toBe(CONTEXT);
    // Поправка Claude Code: Z − X − 1000 не меньше 3000 — ответу есть место.
    expect(CONTEXT - Number(numbers?.[1]) - 1_000).toBeGreaterThanOrEqual(3_000);
    expect(chatCalls).toBe(0);
  });

  it('с max_tokens, который влезает, запрос идёт', async () => {
    await start(() => {
      chatCalls += 1;
      return Promise.resolve(eventStream(stream()));
    });
    expect((await ask(body, 1_000)).status).toBe(200);
    expect(chatCalls).toBe(1);
  });
});

describe('сервер моделей упал: шлюз просит поднять его и не сдаётся', () => {
  it('соединение отказано → сервер поднят → тот же запрос идёт второй раз и отвечает', async () => {
    let revived = 0;
    await start(
      () => {
        chatCalls += 1;
        return chatCalls === 1 ? Promise.reject(refused()) : Promise.resolve(eventStream(stream()));
      },
      {
        revive: () => {
          revived += 1;
          return Promise.resolve('restarted');
        },
      },
    );
    const answer = await ask('привет');
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(stream());
    expect(revived).toBe(1);
    expect(chatCalls).toBe(2);
  });

  it('подъём не удался → 529 overloaded_error (клиент ждёт и повторяет), а не 502, с причиной присмотра', async () => {
    await start(() => Promise.reject(refused()), {
      revive: () => Promise.resolve('capped'),
      notice: () => 'сервер упал и не поднялся после 3 попыток подряд: нехватка видеопамяти',
    });
    const answer = await ask('привет');
    const body = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(529);
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toContain('нехватка видеопамяти');
    expect(body.error.message).toContain('Запустите его в разделе «Локальные модели»');
  });

  it('панель сама перезапускает сервер → 529 «перезапускается», без второго подъёма', async () => {
    await start(() => Promise.reject(refused()), { revive: () => Promise.resolve('busy') });
    const answer = await ask('привет');
    expect(answer.status).toBe(529);
    expect(((await answer.json()) as ErrorBody).error.message).toContain('перезапускается');
  });

  it('сервер остановлен человеком (записи нет) → 529 «остановлен»', async () => {
    await start(() => Promise.reject(refused()), { revive: () => Promise.resolve('none') });
    const answer = await ask('привет');
    expect(answer.status).toBe(529);
    expect(((await answer.json()) as ErrorBody).error.message).toContain('остановлен');
  });

  it('поднялся, но второй запрос тоже упал → 529, а не зависание', async () => {
    await start(() => Promise.reject(refused()), { revive: () => Promise.resolve('restarted') });
    expect((await ask('привет')).status).toBe(529);
  });

  it('не соединение (потолок ожидания, сертификат) серверу воскрешения не нужен: прежний 502', async () => {
    let revived = 0;
    await start(() => Promise.reject(new Error('certificate verify: CERT_UNTRUSTED')), {
      revive: () => {
        revived += 1;
        return Promise.resolve('restarted');
      },
    });
    expect((await ask('привет')).status).toBe(502);
    expect(revived).toBe(0);
  });

  it('не локальный контур: отказ соединения — прежний 502, воскрешения нет', async () => {
    await start(() => Promise.reject(refused()), false);
    expect((await ask('привет')).status).toBe(502);
  });

  it('загружающийся сервер отвечает 503 → клиент получает 529 (ждёт без предела), у облака 503 остаётся', async () => {
    await start(() => Promise.resolve(json(503, { error: { message: 'Loading model' } })));
    expect((await ask('привет')).status).toBe(529);
  });

  it('поток оборвался посреди ответа (сервер убит) → кадр «overloaded_error» и подъём сервера', async () => {
    let revived = 0;
    await start(() => Promise.resolve(eventStream(stream(false))), {
      revive: () => {
        revived += 1;
        return Promise.resolve('restarted');
      },
    });
    const text = await (await ask('привет')).text();
    expect(text).toContain('event: error');
    expect(text).toContain('overloaded_error');
    expect(revived).toBeGreaterThanOrEqual(1);
  });
});
