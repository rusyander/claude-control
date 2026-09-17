import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { saveRules } from '../../dlp/rules-store.ts';
import { writePlatform, writeToken } from '../store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { gatewayPricing } from '../spend.ts';
import { PlatformGateway } from './listener.ts';
import { driverFor } from '../drivers/index.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Шлюз целиком: настоящий слушатель, настоящий HTTP от «CLI», подставленный
 * контур.
 *
 * Проверяется то, ради чего задача и написана: ключ подставляет шлюз и наружу
 * он не выходит НИГДЕ; запрос уходит ровно на один адрес — тот, что в настройке
 * контура; вендорные кадры до клиента не доезжают; отказ проверок содержимого
 * приходит клиенту терминальной ошибкой, а панели — перечнем нарушенного без
 * проверявшегося текста.
 */

/** Ключ-подстановка: латиница, как у настоящего, — иначе он не влез бы в заголовок. */
const SECRET = 'platform-token-9f2b8c1d4e7a0';

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

const DELTA = '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"да"}}]}';
const USAGE =
  '{"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}';

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
/** Куда и с чем ходил шлюз: адреса, заголовки, тела. */
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

/** Контур-заглушка: отдаёт поток кадрами, как настоящий (справочник §7). */
function upstream(
  frames: string[],
  status = 200,
  /** Заголовки отказа: `Retry-After` контура читается только отсюда. */
  extraHeaders: Record<string, string> = {},
): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    if (status >= 400) {
      return Promise.resolve(
        new Response(frames.join(''), {
          status,
          headers: { 'content-type': 'application/json', ...extraHeaders },
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

/** Контур, отвечающий ЦЕЛЬНЫМ телом: так он и отвечает без перевода в поток. */
function wholeBody(payload: unknown, type = 'application/json'): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    return Promise.resolve(
      new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': type },
      }),
    );
  };
}

/** Отказ контура телом, как есть. */
function wholeBodyStatus(status: number, text: string): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    return Promise.resolve(
      new Response(text, { status, headers: { 'content-type': 'application/json' } }),
    );
  };
}

/** Контур, умерший на полуслове: кадры кончились обрывом, а не `[DONE]`. */
function brokenStream(frames: string[], fail: boolean, onEnd?: () => void): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    // Кадры отдаются ПО ОДНОМУ на чтение: `controller.error` выбрасывает всё,
    // что стоит в очереди, и разом набитый поток проверял бы не обрыв, а
    // пустой ответ.
    const queue = [...frames];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const frame = queue.shift();
        if (frame !== undefined) {
          controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
          return;
        }
        onEnd?.();
        if (fail) controller.error(new Error('socket hang up'));
        else controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

async function start(
  fetchImpl: PlatformFetch,
  options: { spendFlushMs?: number; now?: () => Date } = {},
): Promise<void> {
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl,
    ...(options.now ? { now: options.now } : {}),
    // Ноль — «писать сразу»: иначе учёт проверялся бы подгадыванием ожидания к
    // таймеру сброса. Задержка как таковая проверена в `spend-flush.test.ts`.
    spendFlushMs: options.spendFlushMs ?? 0,
  });
  port = gateway.status().port;
}

async function ask(
  path: string,
  body: unknown,
  init: { headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-gateway-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
  calls = [];
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('маршруты шлюза', () => {
  it('поднимается на петле и называет адрес каждого контура', async () => {
    await start(upstream([]));
    const status = gateway.status();
    expect(status.running).toBe(true);
    expect(status.address).toBe(`http://127.0.0.1:${port}`);
    expect(status.routes).toEqual([
      expect.objectContaining({
        platformId: 'enterprise-platform',
        address: `http://127.0.0.1:${port}/enterprise-platform/v1`,
        ready: true,
      }),
    ]);
    // Подписи едут от сервера: снятая гаснет на экране без правки разметки.
    expect(status.compromises).toContain('dialect-bridge');
    expect(status.compromises).toContain('gateway-required');
  });

  it('всё, кроме трёх маршрутов, — 404 с внятным телом', async () => {
    await start(upstream([]));
    const answer = await ask('/enterprise-platform/v1/embeddings', {});
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('/v1/chat/completions');
    expect(calls).toHaveLength(0);
  });

  it('проверка связи CLI (`/api/hello`) — 200 без похода в контур и без записи в сбои', async () => {
    // Claude Code при старте стучится в `<базовый адрес>/api/hello`. Шлюз жив —
    // значит и ответ «жив»; прежний 404 ложился в журнал сбоем на каждый запуск
    // CLI и краснил счётчик шлюза, который работал.
    await start(upstream([]));
    for (const method of ['GET', 'HEAD']) {
      const answer = await fetch(`http://127.0.0.1:${port}/enterprise-platform/api/hello`, {
        method,
      });
      expect(answer.status).toBe(200);
    }
    expect(calls).toHaveLength(0);
    const status = gateway.status();
    expect(status.failures).toBe(0);
    expect(status.events).toHaveLength(0);
  });

  it('неизвестный контур — 404, а не поход неизвестно куда', async () => {
    await start(upstream([]));
    const answer = await ask('/чужой/v1/chat/completions', { model: 'm' });
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('не заведён');
    expect(calls).toHaveLength(0);
  });

  it('выключенный контур отказывает, а не ходит наружу', async () => {
    writePlatform(store, { ...PLATFORM, enabled: false });
    await start(upstream([]));
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'm' });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('выключен');
    expect(calls).toHaveLength(0);
  });

  it('тело больше 32 МБ отклоняется, не читаясь', async () => {
    await start(upstream([]));
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/enterprise-platform/v1/chat/completions',
          method: 'POST',
          // Объявленный размер — тот же отказ, что и настоящий, только без
          // сорока мегабайт в памяти теста.
          headers: { 'content-type': 'application/json', 'content-length': 40 * 1024 * 1024 },
        },
        (incoming) => {
          let text = '';
          incoming.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, text }));
        },
      );
      outgoing.on('error', reject);
      outgoing.write('{"model":"m"}');
      outgoing.end();
    });
    expect(answer.status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  /**
   * §8 №24 второй половиной: потолок ОТВЕТА, а не запроса. Клиенту, просившему
   * не поток, ответ собирается в память целиком — и растёт ровно настолько,
   * насколько контур решит говорить. Без потолка один зациклившийся ответ
   * занял бы память панели, и заметно это стало бы по упавшему процессу.
   *
   * Проверяется по НАСТОЯЩЕМУ пути: кадры идут потоком от контура, отвечает
   * тот же конвейер, что и всегда. Сложенное тело здесь — 12 МБ при потолке в 8.
   */
  it('собранный ответ больше потолка — отказ, а не память панели', async () => {
    const chunk = 'я'.repeat(256 * 1024);
    const frames = Array.from({ length: 24 }, () =>
      JSON.stringify({ choices: [{ index: 0, delta: { content: chunk } }] }),
    );
    await start(upstream([...frames, USAGE, '[DONE]']));

    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });

    expect(answer.status).toBe(413);
    expect(answer.text).toContain('8 МБ');
    // Потоковый клиент этого потолка не видит: там ответ уходит кусками и в
    // памяти не копится, поэтому запрещать длинный ответ незачем.
    expect(answer.text).toContain('потоком');
  });
});

describe('ключ подставляет шлюз', () => {
  it('ключ уходит заголовком контуру и не появляется больше нигде', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    const answer = await ask(
      '/enterprise-platform/v1/chat/completions',
      { model: 'gpt-x', messages: [{ role: 'user', content: 'привет' }], stream: true },
      // CLI настроен на любой ключ-заглушку: подменить им ключ контура нельзя.
      { headers: { authorization: 'Bearer client-placeholder' } },
    );

    expect(answer.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.dev.example.ru/v1/chat/completions');
    expect(JSON.stringify(calls[0]?.headers)).toContain(SECRET);
    expect(JSON.stringify(calls[0]?.headers)).not.toContain('client-placeholder');

    // Ни в ответе клиенту, ни в следе для панели ключа нет.
    expect(answer.text).not.toContain(SECRET);
    expect(JSON.stringify(gateway.status())).not.toContain(SECRET);
  });

  it('запрос уходит ровно на один адрес — тот, что в настройке', async () => {
    await start(upstream([DELTA, '[DONE]']));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(calls.map((call) => new URL(call.url).origin)).toEqual(['https://api.dev.example.ru']);
  });
});

describe('поток клиенту', () => {
  it('вендорные кадры не доезжают, обычные доезжают, расход снят', async () => {
    await start(
      upstream([
        '{"platform_status":"thinking"}',
        '{"platform_status":"summarizing"}',
        '{"platform_reasoning":"я думаю"}',
        DELTA,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.text).not.toContain('platform_');
    expect(answer.text).toContain('"content":"да"');
    expect(answer.text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const status = gateway.status();
    expect(status.usage[0]).toMatchObject({
      platformId: 'enterprise-platform',
      totalTokens: 12,
      requests: 1,
    });
    // Денег в журнале шлюза нет: «внутренняя единица контура» была выдумкой.
    expect(status.usage[0]).not.toHaveProperty('unitUsd');
    expect(status.events[0]).toMatchObject({ summarized: true, stages: expect.any(Array) });
    // Кадр размышления наружу не идёт, но стадией в след — да (аудит MD-02).
    expect(status.events[0]?.stages).toEqual(['thinking', 'summarizing', 'reasoning']);
  });

  it('клиент в диалекте anthropic получает свой поток', async () => {
    await start(
      upstream([
        DELTA,
        '{"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}',
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 50,
      system: 'ты помощник',
      messages: [{ role: 'user', content: 'привет' }],
      stream: true,
    });

    expect(answer.text).toContain('event: message_start');
    expect(answer.text).toContain('"text":"да"');
    expect(answer.text).toContain('"stop_reason":"end_turn"');
    expect(answer.text).toContain('event: message_stop');

    // Наверх ушёл диалект контура, с системной строкой первой репликой.
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      messages: { role: string }[];
      stream: boolean;
    };
    expect(sent.messages[0]?.role).toBe('system');
    expect(sent.stream).toBe(true);
  });

  it('расход внутри кадра с ответом не теряется: журнал и итог клиенту видят токены', async () => {
    // Так отдаёт настоящий контур (router.py:898–912) и litellm: `usage` едет в
    // кадре с НЕпустым `choices`. Разбор ждал пустого и записывал ноль токенов.
    await start(
      upstream([
        DELTA,
        '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(answer.text).toContain('"total_tokens":10');
    // Кадр расхода — после кадра завершения, как у OpenAI: клиент, читающий
    // `finish_reason` концом ответа, иначе расход не увидит.
    expect(answer.text.indexOf('"finish_reason":"stop"')).toBeLessThan(
      answer.text.indexOf('"total_tokens":10'),
    );
    expect(gateway.status().usage[0]).toMatchObject({ totalTokens: 10, requests: 1 });
    expect(gateway.status().events[0]).toMatchObject({ status: 200, totalTokens: 10 });
    expect(gateway.status().events[0]).not.toHaveProperty('usageUnreported');
  });

  it('контур не прислал расход — след называет это, а не пишет молчаливый ноль', async () => {
    // Аудит MD-09: картинка частью ответа у платформы компании приходит без кадра usage, и
    // расход ключа получал ноль — справка при этом обещала «в расходе ключа».
    await start(
      upstream([
        DELTA,
        '{"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
      ]),
    );
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    expect(gateway.status().events[0]).toMatchObject({
      status: 200,
      totalTokens: 0,
      usageUnreported: true,
    });
  });

  it('итоговый текст контура заменяет отданный: журнал помечает расхождение', async () => {
    await start(
      upstream([
        '{"choices":[{"index":0,"delta":{"content":"Пишите на [EMAIL_1]"}}]}',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '{"platform_deanonymized":"Пишите на ivan@example.ru"}',
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'куда писать?' }],
    });

    const body = JSON.parse(answer.text) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe('Пишите на ivan@example.ru');
    expect(gateway.status().events[0]).toMatchObject({ rewritten: 'diverged' });
  });
});

describe('клиент просил не поток', () => {
  it('наверх всё равно уходит поток, а ответ собирается целиком', async () => {
    await start(
      upstream([
        DELTA,
        '{"choices":[{"index":0,"delta":{"content":"!"},"finish_reason":"stop"}]}',
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });

    const body = JSON.parse(answer.text) as {
      choices: { message: { content: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe('да!');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(12);

    // Не-потоковый вызов контур рвёт на 120 с — поэтому наверх ушёл поток.
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      stream: boolean;
      stream_options: { include_usage: boolean };
    };
    expect(sent.stream).toBe(true);
    expect(sent.stream_options.include_usage).toBe(true);
  });

  it('anthropic без потока получает цельное сообщение своего диалекта', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'привет' }],
    });
    const body = JSON.parse(answer.text) as {
      type: string;
      content: { text: string }[];
      usage: { input_tokens: number };
    };
    expect(body.type).toBe('message');
    expect(body.content[0]?.text).toBe('да');
    expect(body.usage.input_tokens).toBe(10);
  });

  describe('прочитанный из кэша вход доезжает до клиента Anthropic', () => {
    // Контур отдаёт тело модели как есть (inst-api `handler_public_api.go`), и
    // OpenAI-совместимый апстрим кладёт кэш в `prompt_tokens_details`. Мост терял
    // его, и транскрипт CLI записывал весь вход свежим: у Anthropic
    // `input_tokens` кэша НЕ включает, а `cache_read_input_tokens` оставался нулём.
    const CACHED =
      '{"id":"c1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":5,"total_tokens":1005,"prompt_tokens_details":{"cached_tokens":800}}}';

    it('без потока', async () => {
      await start(upstream([DELTA, CACHED, '[DONE]']));
      const answer = await ask('/enterprise-platform/v1/messages', {
        model: 'gpt-x',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'привет' }],
      });
      const body = JSON.parse(answer.text) as { usage: Record<string, number> };
      expect(body.usage).toEqual({
        input_tokens: 200,
        cache_read_input_tokens: 800,
        output_tokens: 5,
      });
    });

    it('потоком — в итоговом message_delta', async () => {
      await start(upstream([DELTA, CACHED, '[DONE]']));
      const answer = await ask('/enterprise-platform/v1/messages', {
        model: 'gpt-x',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'привет' }],
        stream: true,
      });
      const delta = answer.text.slice(answer.text.indexOf('event: message_delta'));
      expect(delta).toContain('"input_tokens":200');
      expect(delta).toContain('"cache_read_input_tokens":800');
      expect(delta).toContain('"output_tokens":5');
    });

    it('клиент OpenAI без потока получает кэш в своём поле', async () => {
      await start(upstream([DELTA, CACHED, '[DONE]']));
      const answer = await ask('/enterprise-platform/v1/chat/completions', {
        model: 'gpt-x',
        messages: [{ role: 'user', content: 'привет' }],
      });
      const body = JSON.parse(answer.text) as { usage: Record<string, unknown> };
      expect(body.usage.prompt_tokens).toBe(1000);
      expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 800 });
    });
  });

  it('картинка-часть доезжает и без потока, а в след идёт её размер', async () => {
    // Потоком такой кадр уходит клиенту байт в байт, и собранное тело обязано
    // нести ту же часть: до Т9 оно собиралось из одного текста, и клиент,
    // выключивший поток, получал ответ без картинки и без единого слова о ней.
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    await start(
      upstream([
        `{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"вот"},{"type":"image_url","image_url":{"url":"${url}"}}]}}]}`,
        USAGE,
        '[DONE]',
      ]),
    );

    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'нарисуй' }],
    });

    const body = JSON.parse(answer.text) as {
      choices: { message: { content: Array<{ type: string; text?: string }> } }[];
    };
    const content = body.choices[0]?.message.content ?? [];
    expect(content[0]).toMatchObject({ type: 'text', text: 'вот' });
    expect(content[1]).toMatchObject({ type: 'image_url', image_url: { url } });

    // След несёт РАЗМЕР, а не содержимое: журнал читает человек, и мегабайт
    // base64 сделал бы его нечитаемым целиком.
    const event = gateway.status().events.at(-1);
    expect(event?.imageBytes).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain('iVBORw0KGgo');
  });
});

describe('отказы контура', () => {
  it('451 в потоке приходит клиенту терминальной ошибкой, панели — перечнем', async () => {
    await start(
      upstream([
        DELTA,
        '{"platform_guardrails":{"stream_interrupted":true,"violations":[{"category":"pii_phone","text":"телефон 89001234567"}]}}',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.text).toContain('content_policy_violation');
    expect(answer.text).toContain('pii_phone');
    // Проверявшийся текст не уходит ни клиенту, ни в след панели.
    expect(answer.text).not.toContain('89001234567');
    const event = gateway.status().events[0];
    expect(event?.violations).toEqual(['pii_phone']);
    expect(JSON.stringify(event)).not.toContain('89001234567');
  });

  it('два правила в одном запросе: исход приписан тому, чей кадр его принёс', async () => {
    // Живой dev 14.09: одно правило замаскировало вход, другое оборвало ответ.
    // Сводка вешала оба исхода на оба имени — запрет маркера «маскировал данные».
    await start(
      upstream([
        '{"platform_sanitized":{"violations":[{"rule_name":"секреты без NER"}]}}',
        DELTA,
        '{"platform_guardrails":{"stream_interrupted":true,"violations":[{"rule_name":"запрет маркера"}]}}',
      ]),
    );
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    const rows = gateway.status().violations.rows;
    expect(rows.find((row) => row.name === 'секреты без NER')?.actions).toEqual(['masked']);
    expect(rows.find((row) => row.name === 'запрет маркера')?.actions).toEqual(['interrupted']);
  });

  it('ошибка кадром посреди потока — отказ с причиной контура, а не пустой ответ 200', async () => {
    // litellm и прокси поверх него отдают отказ поставщика объектом `error` уже
    // после заголовков 200. Раньше это был «незнакомый кадр» и пустой успех.
    const frames = [
      DELTA,
      '{"error":{"message":"Лимит запросов модели исчерпан","type":"rate_limit_error","code":"rate_limit_exceeded"}}',
    ];
    await start(upstream(frames));
    const whole = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(whole.status).toBe(429);
    expect(whole.text).toContain('Лимит запросов модели исчерпан');
    expect(gateway.status().events[0]).toMatchObject({
      status: 429,
      error: 'Контур прервал ответ: Лимит запросов модели исчерпан',
    });
    await gateway.stop();

    await start(upstream(frames));
    const streamed = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    // Заголовки потока уже ушли — отказ доезжает терминальным кадром ошибки.
    expect(streamed.text).toContain('rate_limit_error');
    expect(streamed.text).toContain('Лимит запросов модели исчерпан');
    expect(streamed.text).not.toContain('"finish_reason":"stop"');
  });

  it('451 ответом (а не кадром) переводится в понятный отказ', async () => {
    await start(
      upstream(
        [
          JSON.stringify({
            type: 'guardrail_violation',
            code: 'content_policy_violation',
            violations: [{ category: 'secrets', text: 'secret-abc123def456' }],
          }),
        ],
        451,
      ),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('secrets');
    expect(answer.text).not.toContain('secret-abc123def456');
    expect(gateway.status().events[0]?.violations).toEqual(['secrets']);
  });

  it('451 вне потока даёт ровно тот же отказ, что и в потоке', async () => {
    // Критерий Т6: понятность не должна зависеть от того, просил клиент поток
    // или нет. Раньше это держалось только на том, что оба пути идут через одну
    // ветку кода, — а «идут через одну ветку» проверяется не чтением, а
    // сравнением двух ответов.
    const body = [
      JSON.stringify({
        type: 'guardrail_violation',
        violations: [{ category: 'secrets', text: 'secret-abc123def456' }],
      }),
    ];

    await start(upstream(body, 451));
    const streamed = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    await gateway.stop();

    await start(upstream(body, 451));
    const plain = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: false,
    });

    expect(plain.status).toBe(streamed.status);
    expect(plain.text).toBe(streamed.text);
    expect(plain.text).toContain('secrets');
    expect(plain.text).not.toContain('secret-abc123def456');
  });

  it('отказ проверок помечен фактом, а отказ ключа — нет', async () => {
    // Клиенту 451 уезжает четырёхсотым и по коду неотличим от отклонённого
    // ключа, кончившегося бюджета и лимита частоты. Считать любой отказ отказом
    // проверок значило бы отправить человека чинить свой запрос там, где
    // кончился бюджет.
    await start(upstream([JSON.stringify({ violations: ['pii'] })], 451));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(gateway.status().events[0]).toMatchObject({ blocked: true });
    await gateway.stop();

    await start(upstream([JSON.stringify({ error: { message: 'Бюджет исчерпан' } })], 402));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    const paid = gateway.status();
    expect(paid.events[0]).toMatchObject({ blocked: false });
    // И в сводке проверок такого отказа нет вовсе.
    expect(paid.violations.blockedUnnamed).toBe(0);
  });

  it('451 без единого названия не исчезает из сводки', async () => {
    // Просеиватель имён строг намеренно, а живого 451 никто ещё не видел:
    // ответ, названий не приславший, — обычное дело. Раньше такой запрос
    // пропадал целиком, и карточка писала «проверки ни разу не срабатывали»
    // человеку, чей запрос контур не принял.
    await start(
      upstream([JSON.stringify({ error: { message: 'Запрос остановлен проверками' } })], 451),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.status).toBe(400);
    const report = gateway.status().violations;
    expect(report.rows).toEqual([]);
    expect(report.blockedUnnamed).toBe(1);
  });

  it('замаскированные данные — отдельный факт, а не строка в перечне', async () => {
    // Ответ приходит целым, и без пометки человек читает его как ответ на свой
    // запрос — а модель отвечала на исправленный.
    await start(
      upstream([
        '{"platform_sanitized":{"violations":[{"category":"pii_email","text":"ivanov@corp.ru"}]}}',
        DELTA,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.status).toBe(200);
    const status = gateway.status();
    expect(status.events[0]?.masked).toBe(true);
    expect(status.events[0]?.interrupted).toBe(false);
    expect(status.events[0]?.violations).toEqual(['pii_email']);
    expect(JSON.stringify(status)).not.toContain('ivanov@corp.ru');
    expect(status.violations.rows[0]).toMatchObject({
      name: 'pii_email',
      count: 1,
      actions: ['masked'],
    });
  });

  it('контур не отвечает ⇒ 502 с русской причиной и без ухода на другой адрес', async () => {
    await start(() => Promise.reject(new Error('ECONNREFUSED 10.0.0.1:443')));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('Нет связи с контуром');
    expect(gateway.status().failures).toBe(1);
  });

  it('402 приходит своим кодом и русской причиной контура', async () => {
    await start(upstream([JSON.stringify({ error: { message: 'Бюджет ключа исчерпан' } })], 402));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(402);
    expect(answer.text).toContain('Бюджет ключа исчерпан');
  });

  // Исчерпанный бюджет ключа контур отдаёт кодом 401 — тем же, что и отозванный
  // ключ (`inst-admin-api/internal/store/keys.go` `ValidateKey`), и различить их
  // снаружи нечем. Совет «перевыпустите ключ» отправлял бы человека с кончившимся
  // бюджетом чинить не то.
  /**
   * §8 №5, №6, №7 разом. Контур ЗНАЕТ, какая из причин сработала — тексты
   * лежат в двух местах: `inst-admin-api/.../store/keys.go` `ValidateKey`
   * отвечает «key expired» и «budget exceeded», а `.../service/key_service.go`
   * `Validate` добавляет «invalid API key», «key owner is deleted» и «key
   * owner check failed». Всё это теряет `inst-api/internal/auth/apikey.go`: на
   * 401 от админки он отдаёт `nil, nil`, и клиент видит плоское «invalid API
   * key». Поэтому «истёк по сроку» отдельным текстом (§8 №6) панель дать НЕ
   * МОЖЕТ — и называет все пять причин, вместо того чтобы выбрать одну наугад.
   * Пятая («сверка владельца не удалась») тем и важна, что она НЕ про ключ:
   * человек, которому назвали бы только четыре, чинил бы исправный ключ.
   */
  it('401 называет ВСЕ ПЯТЬ причин, а не советует перевыпустить ключ', async () => {
    await start(upstream([JSON.stringify({ error: { message: 'invalid API key' } })], 401));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(401);
    for (const cause of ['отозван', 'срок', 'бюджет', 'владельца', 'сверка владельца']) {
      expect(answer.text).toContain(cause);
    }
  });

  /**
   * §8 №9, вторая половина строки: «когда повторить». Свой авто-повтор шлюз
   * делает молча и ровно один; дальше решает человек, и без секунд «слишком
   * часто» неотличимо от «сломалось». Секунды берутся у контура, а не
   * выдумываются: `Retry-After` — единственный, кто про них знает.
   */
  it('429 говорит, ЧЕРЕЗ СКОЛЬКО повторить — числом контура, а не своим', async () => {
    await start(
      upstream([JSON.stringify({ error: { message: 'rate limited' } })], 429, {
        'retry-after': '42',
      }),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(429);
    expect(answer.text).toContain('42');
  });

  /**
   * §8 №8: «ключу не разрешена модель» без имени модели чинить нечем — в CLI
   * этот текст читают в консоли, рядом с которой списка моделей нет.
   */
  it('403 называет МОДЕЛЬ и место, где лежит список разрешённых', async () => {
    await start(upstream([JSON.stringify({ error: { message: 'model not allowed' } })], 403));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'company-opus-x',
      stream: true,
    });
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('company-opus-x');
    expect(answer.text).toContain('админке');
  });

  /**
   * §8 №13 и §8 №1 в одном ответе, и это не осторожность ради осторожности.
   * Шлюз всегда стучится в один и тот же путь под адресом контура, поэтому 404
   * означает и «модель убрали между прогонами», и «адрес указывает не на
   * публичный API» — например, на админку. Различить их здесь нечем: тела у
   * такого ответа обычно нет вовсе. Названо ОДНО из двух — половина людей идёт
   * чинить не то; поэтому названы оба.
   */
  it('404 на чате называет ОБА чтения: исчезнувшая модель и неверный адрес', async () => {
    await start(upstream([JSON.stringify({ error: { message: 'model not found' } })], 404));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'ушедшая',
      stream: true,
    });
    expect(answer.status).toBe(404);
    expect(answer.text).toContain('ушедшая');
    expect(answer.text).toContain('пропавшие');
    expect(answer.text).toContain('админку');
  });
});

describe('правила защиты данных в конвейере', () => {
  /** Включить защиту данных с одним правилом — как это делает человек. */
  function withRule(action: 'mask' | 'block'): void {
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    saveRules(appData, [
      {
        id: 'r1',
        name: 'Фамилии сотрудников',
        enabled: true,
        kind: 'terms',
        terms: ['Иванов'],
        pattern: '',
        action,
        label: 'ИМЯ',
      },
    ]);
  }

  it('найденное заменяется меткой ДО отправки и возвращается в ответе', async () => {
    withRule('mask');
    await start(
      upstream([
        '{"id":"c1","choices":[{"index":0,"delta":{"content":"нашёл [ИМЯ_1.1]"}}]}',
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'кто такой Иванов' }],
      stream: true,
    });

    // Наверх ушла метка, а не фамилия.
    expect(calls[0]?.body).not.toContain('Иванов');
    // Метка — с номером формы: вид `[ИМЯ_1]` совпадает с видом меток платформы компании, и её
    // деанонимизатор развернул бы нашу метку в своё значение.
    expect(calls[0]?.body).toContain('[ИМЯ_1.1]');
    // Клиенту метка возвращается значением: CLI видит свой текст.
    expect(answer.text).toContain('нашёл Иванов');
  });

  it('правило «отклонить» останавливает запрос, и наружу он не уходит', async () => {
    withRule('block');
    await start(upstream([DELTA, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'кто такой Иванов' }],
      stream: true,
    });

    // 400, а не 403: Claude Code читает 403 как ошибку входа и дописывает «Failed to
    // authenticate.» — человек чинил бы ключ, а остановило его правило данных.
    expect(answer.status).toBe(400);
    expect(answer.text).toContain('invalid_request_error');
    expect(answer.text).toContain('Фамилии сотрудников');
    expect(calls).toHaveLength(0);
  });
});

// Р11, 15.09.2026. Проба dev показала: по ключу платформа компании не подменяет ничего, и
// модель видела почту, телефон и IP как есть. Маска контура, объявившего подмену,
// включается сама — без общего выключателя и без единого своего правила.
describe('маска контура без общего выключателя (Р11)', () => {
  const PERSONAL = 'пиши на a.b@example.com, сервер 192.168.1.10';

  function personal(): Promise<{ status: number; text: string }> {
    return ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: PERSONAL }],
      stream: true,
    });
  }

  it('контур с подменой данных маскирует встроенным набором и возвращает значения', async () => {
    await start(
      upstream([
        '{"id":"c1","choices":[{"index":0,"delta":{"content":"пишу на [ПОЧТА_1.1]"}}]}',
        '[DONE]',
      ]),
    );
    const answer = await personal();

    expect(store.getSettings().dlp.enabled).toBe(false);
    expect(calls[0]?.body).not.toContain('a.b@example.com');
    expect(calls[0]?.body).not.toContain('192.168.1.10');
    expect(calls[0]?.body).toContain('[ПОЧТА_1.1]');
    expect(answer.text).toContain('пишу на a.b@example.com');
  });

  it('ключ во встроенном наборе останавливает запрос до сети', async () => {
    await start(upstream([DELTA, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: `ключ ${['gh', 'p_', 'a'.repeat(36)].join('')}` }],
      stream: true,
    });

    expect(answer.status).toBe(400);
    expect(answer.text).toContain('invalid_request_error');
    expect(answer.text).toContain('Ключи и токены сервисов');
    expect(calls).toHaveLength(0);
  });

  it('выбор человека на карточке снимает маску контура, общий выключатель — нет', async () => {
    writePlatform(store, { ...PLATFORM, dataMask: false });
    await start(upstream([DELTA, '[DONE]']));
    await personal();
    expect(calls[0]?.body).toContain('a.b@example.com');

    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    await personal();
    expect(calls[1]?.body).not.toContain('a.b@example.com');
  });

  it('контур, не объявивший подмену, без общего выключателя уходит без маски', async () => {
    writePlatform(store, { ...PLATFORM, driver: 'openai-compat', toolShim: false });
    await start(upstream([DELTA, '[DONE]']));
    await personal();
    expect(calls[0]?.body).toContain('a.b@example.com');
  });

  it('свои включённые правила раздела заменяют встроенный набор', async () => {
    saveRules(appData, [
      {
        id: 'r1',
        name: 'Фамилии сотрудников',
        enabled: true,
        kind: 'terms',
        terms: ['Иванов'],
        pattern: '',
        action: 'mask',
        label: 'ИМЯ',
      },
    ]);
    await start(upstream([DELTA, '[DONE]']));
    await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: `Иванов, ${PERSONAL}` }],
      stream: true,
    });
    expect(calls[0]?.body).not.toContain('Иванов');
    // Почту свой набор не ловит: человек выбрал свои правила, и карточка говорит
    // «свои правила раздела», а не «встроенный набор».
    expect(calls[0]?.body).toContain('a.b@example.com');
  });
});

describe('контур ответил не потоком', () => {
  /** Перевод в поток выключен человеком — единственная настройка, которая это меняет. */
  function withoutForceStream(): void {
    const gatewaySettings = store.getSettings().platformGateway;
    store.updateSettings({ platformGateway: { ...gatewaySettings, forceStream: false } });
  }

  it('цельный ответ доезжает до клиента целиком, а не пустым', async () => {
    withoutForceStream();
    await start(
      wholeBody({
        id: 'c1',
        model: 'gpt-x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });

    // Пустой ответ с нулевым расходом и кодом 200 — тихая потеря данных: клиент
    // считает, что модель промолчала, а она ответила.
    const body = JSON.parse(answer.text) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(answer.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe('ответ');
    expect(body.usage.total_tokens).toBe(7);
    expect(gateway.status().events[0]).toMatchObject({ status: 200, totalTokens: 7 });

    // Наверх ушёл ровно тот запрос, который прислал клиент: поток не навязан.
    expect(JSON.parse(calls[0]?.body ?? '{}')).not.toHaveProperty('stream');
  });

  it('цельный ответ доезжает и до клиента в диалекте anthropic', async () => {
    withoutForceStream();
    await start(
      wholeBody({
        id: 'c1',
        model: 'gpt-x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    );
    const answer = await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'привет' }],
    });
    const body = JSON.parse(answer.text) as { content: { text: string }[] };
    expect(body.content[0]?.text).toBe('ответ');
  });

  it('вердикт проверок из цельного тела доезжает в панель, а не теряется', async () => {
    // В цельном теле вердикты по выходу как раз и живут (справочник §7).
    // Пересобирая тело в кадры, конвейер брал только `choices` и `usage` — и
    // запрос, по которому контур вынес решение, приезжал в панель как «проверки
    // молчали».
    withoutForceStream();
    await start(
      wholeBody({
        id: 'c1',
        model: 'gpt-x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        platform_sanitized: { violations: [{ category: 'pii_phone' }] },
      }),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'мой телефон 89001234567' }],
    });

    expect(answer.status).toBe(200);
    expect(gateway.status().events[0]).toMatchObject({
      masked: true,
      violations: ['pii_phone'],
    });
    // Ответ при этом целый: вердикт не съел текст.
    expect(JSON.parse(answer.text).choices[0].message.content).toBe('ответ');
  });

  it('контур сказал «инструменты выброшены» — это потеря, а не незнакомый кадр', async () => {
    // Кадр контура про инструменты панель выносила вперёд ответа (он в списке
    // вендорных полей) и тут же не узнавала: в карточке он оказывался среди
    // незнакомых, то есть «панель такого не знает». А знает: это подтверждение
    // самой платформой того, что схемы инструментов до модели не дошли, —
    // единственное объяснение агенту, ничего не сделавшему руками.
    withoutForceStream();
    await start(
      wholeBody({
        id: 'c1',
        model: 'gpt-x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ответ' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        platform_tools_unavailable: true,
      }),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'посчитай' }],
    });

    expect(answer.status).toBe(200);
    const event = gateway.status().events[0];
    expect(event?.lost).toContain('tools');
    expect(event?.unknownFrames).toEqual([]);
    // Служебный кадр наружу не ушёл: строгий клиент на нём ломается.
    expect(answer.text).not.toContain('platform_tools_unavailable');
  });

  it('тело, которое и не поток, и не ответ модели, — честный отказ', async () => {
    withoutForceStream();
    await start(wholeBody('<html>вход в корпоративный портал</html>', 'text/html'));
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x' });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('не разбирается как ответ модели');
  });
});

describe('поток оборвался', () => {
  it('обрыв связи посреди ответа: клиент видит ошибку, панель — событие и расход', async () => {
    await start(brokenStream([DELTA, USAGE], true));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    // Молча закрытый поток CLI показал бы как удачный короткий ответ.
    expect(answer.text).toContain('Ответ контура оборвался');
    const status = gateway.status();
    expect(status.events[0]).toMatchObject({ status: 502, totalTokens: 12 });
    expect(status.usage[0]?.totalTokens).toBe(12);
    // Беда одного запроса не красит весь слушатель в отказ.
    expect(status.error).toBeUndefined();
    expect(status.running).toBe(true);
  });

  /**
   * §8 №16: «учёт не удваивается». Расход снимается ОДИН раз, после ответа
   * клиенту, — а на оборванном потоке путь до этого места проходит через
   * catch, и посчитать дважды (в кадре расхода и на закрытии) было бы легко.
   */
  it('обрыв не удваивает учёт: один запрос — одна запись и один расход', async () => {
    await start(brokenStream([DELTA, USAGE], true));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    const status = gateway.status();
    expect(status.events).toHaveLength(1);
    expect(status.requests).toBe(1);
    expect(status.usage).toHaveLength(1);
    // Токены — ровно те, что успели прийти, а не их удвоение.
    expect(status.usage[0]).toMatchObject({ requests: 1, totalTokens: 12 });
  });

  it('поток кончился без [DONE] — это обрыв, а не законченный ответ', async () => {
    await start(brokenStream([DELTA, USAGE], false));
    const answer = await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'привет' }],
      stream: true,
    });

    expect(answer.text).toContain('event: error');
    expect(answer.text).not.toContain('"stop_reason":"end_turn"');
    expect(gateway.status().events[0]?.status).toBe(502);
  });

  it('клиент ушёл посреди ответа — поход наверх отменяется сразу, а не на следующей записи', async () => {
    // Аудит GW-06: отмена висела на `close` входящего запроса, а его Node 22 шлёт,
    // едва тело дочитано. Контур продолжал отвечать и списывать расход в закрытое
    // соединение, пока молчание не упиралось в следующую запись.
    let noteAbort: () => void = () => undefined;
    const upstreamAborted = new Promise<string>((resolve) => {
      noteAbort = () => resolve('отменён');
    });
    await start((url, init) => {
      calls.push({ url, headers: init?.headers ?? {}, body: init?.body ?? '' });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${DELTA}\n\n`));
          // Дальше контур «думает» и молчит — как в долгом цикле инструментов.
          init?.signal?.addEventListener(
            'abort',
            () => {
              noteAbort();
              controller.error(new Error('aborted'));
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    });

    const client = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/enterprise-platform/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-x', stream: true }),
        signal: client.signal,
      },
    );
    const reader = response.body?.getReader();
    await reader?.read();
    client.abort();

    const outcome = await Promise.race([
      upstreamAborted,
      new Promise<string>((resolve) => setTimeout(() => resolve('всё ещё идёт'), 1000)),
    ]);
    expect(outcome).toBe('отменён');
  });

  /**
   * Аудит MD-04: сервер платформы компании держит ЛЮБОЙ ответ не дольше 120 с (`WriteTimeout`
   * без продления на потоке), и поток рвётся так же, как цельный ответ. Обрыв на
   * этой секунде назывался «поток закончился без завершающего кадра» — и человек
   * шёл чинить сеть. Часы подставлены, потому что ждать две минуты тест не может:
   * они сдвигаются ровно в тот момент, когда контур замолкает.
   */
  it('обрыв на потолке платформы назван потолком, а не сетью — и в потоке, и в следе', async () => {
    // Три дороги обрыва: поток кончился молча, поток упал ошибкой сокета, и
    // клиент без потока, которому ответ собирается целиком.
    const cases: [string, boolean, boolean][] = [
      ['поток, молча', false, true],
      ['поток, сокет', true, true],
      ['цельный ответ', false, false],
    ];
    for (const [name, fail, stream] of cases) {
      let clock = Date.parse('2026-09-13T10:00:00.000Z');
      await start(
        brokenStream([DELTA], fail, () => {
          clock += 121_000;
        }),
        { now: () => new Date(clock) },
      );
      const answer = await ask('/enterprise-platform/v1/chat/completions', {
        model: 'gpt-x',
        stream,
      });

      expect(answer.text, name).toContain('потолок');
      expect(answer.text, name).toContain('120');
      expect(gateway.status().events.at(-1)?.error, name).toContain('потолок');
    }
  });

  it('короткий обрыв потолком не называется: до потолка далеко', async () => {
    let clock = Date.parse('2026-09-13T10:00:00.000Z');
    await start(
      brokenStream([DELTA], false, () => {
        clock += 30_000;
      }),
      { now: () => new Date(clock) },
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.text).toContain('без завершающего кадра');
    expect(answer.text).not.toContain('потолок');
  });

  it('потолок, объявленный человеком у совместимого шлюза, называет обрыв так же', async () => {
    // Шлюз за прокси, рвущим соединение через минуту: ни один пресет этого не
    // знает, поэтому потолок — поле переопределений, а не код драйвера.
    const proxied: Platform = {
      ...PLATFORM,
      id: 'proxied',
      driver: 'vllm',
      toolShim: false,
      manifest: { responseCeilingSec: 60 },
    };
    writePlatform(store, proxied);
    writeToken(appData, proxied.id, SECRET);
    let clock = Date.parse('2026-09-13T10:00:00.000Z');
    await start(
      brokenStream([DELTA], false, () => {
        clock += 61_000;
      }),
      { now: () => new Date(clock) },
    );
    const answer = await ask('/proxied/v1/chat/completions', { model: 'gpt-x', stream: true });

    expect(answer.text).toContain('потолок');
    expect(answer.text).toContain('60');
  });

  it('оборванный ответ не отдаётся цельным телом под видом целого', async () => {
    await start(brokenStream([DELTA, USAGE], false));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('оборвался');
  });
});

describe('след запроса для панели', () => {
  it('потери перевода названы, тел и текстов в следе нет', async () => {
    // Прослойка выключена: инструменты некуда девать, и это ПОТЕРЯ — ровно то,
    // что человек читает как «агент без рук».
    writePlatform(store, { ...PLATFORM, toolShim: false });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'мой секретный промпт' }],
      tools: [{ name: 'Read' }],
      stream: true,
    });

    const event = gateway.status().events[0];
    expect(event?.lost).toContain('tools');
    expect(event?.shimmed).toEqual([]);
    expect(JSON.stringify(event)).not.toContain('мой секретный промпт');
    expect(JSON.stringify(event)).not.toContain('да');
  });

  it('с прослойкой инструменты названы перенесёнными текстом, а не потерянными', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'создай файл' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      stream: true,
    });

    const event = gateway.status().events[0];
    // Т5.4: `tools: shimmed` — и ни одной строки о потере там, где потери нет.
    expect(event?.shimmed).toEqual(['tools', 'tool_choice']);
    expect(event?.lost).not.toContain('tools');
  });

  it('потери называются и клиенту в диалекте самого контура', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
      // Переводить тут нечего — а контур всё равно выбросит половину полей
      // своей же схемой (справочник §5), и без следа это выглядело бы как
      // «перенеслось всё».
      tools: [{ type: 'function', function: { name: 'read' } }],
      response_format: { type: 'json_object' },
      n: 2,
      user: 'ivanov',
      stream: true,
    });

    const event = gateway.status().events[0];
    // `tools` здесь не теряются — их забирает прослойка (Т5.3); остальное контур
    // выбрасывает своей схемой, и об этом человек должен прочитать в следе.
    expect(event?.shimmed).toContain('tools');
    expect(event?.lost).toEqual(expect.arrayContaining(['response_format', 'n', 'user']));
    // Присланного клиентом там нет — только имена полей.
    expect(event?.lost).not.toContain('ivanov');
  });

  it('путь в следе идёт без строки запроса: в ней бывает ключ', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await fetch(
      `http://127.0.0.1:${port}/enterprise-platform/v1/chat/completions?key=sk-secret-in-url`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-x', stream: true }),
      },
    );

    const event = gateway.status().events[0];
    expect(event?.path).toBe('/enterprise-platform/v1/chat/completions');
    expect(JSON.stringify(gateway.status())).not.toContain('sk-secret-in-url');
  });
});

describe('список моделей', () => {
  const LIST = { object: 'list', data: [{ id: 'gpt-x', object: 'model', created: 1_700_000_000 }] };

  it('клиенту в диалекте OpenAI список уходит как есть', async () => {
    await start(wholeBody(LIST));
    const answer = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/models`);
    expect(JSON.parse(await answer.text())).toEqual(LIST);
  });

  it('клиенту в диалекте anthropic список переводится', async () => {
    await start(wholeBody(LIST));
    // Путь у списка моделей в обоих диалектах один, поэтому клиента выдаёт
    // заголовок версии — его API Anthropic требует от каждого запроса. Чужую
    // форму такой клиент читает как «моделей нет» у настроенного контура.
    const answer = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/models`, {
      headers: { 'anthropic-version': '2023-06-01' },
    });
    const body = JSON.parse(await answer.text()) as {
      data: { type: string; id: string; display_name: string }[];
    };
    expect(body.data[0]).toMatchObject({ type: 'model', id: 'gpt-x', display_name: 'gpt-x' });
  });
});

describe('постоянный учёт расхода (Т8)', () => {
  it('расход ответа ложится в учёт, переживающий перезапуск панели', async () => {
    await start(upstream([DELTA, USAGE]));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    const record = store.getPlatformSpend()['enterprise-platform']!;
    const day = record.days[0]!;
    expect(day.requests).toBe(1);
    expect(day.promptTokens).toBe(10);
    expect(day.completionTokens).toBe(2);
    expect(day.totalTokens).toBe(12);
    // Модели компании в прайсе нет и быть не может: токены посчитаны, деньги —
    // нет, а сама модель названа поимённо.
    expect(day.money.usd).toBe(0);
    expect(day.money.unpricedModels).toEqual(['gpt-x']);

    // Живой счётчик шлюза считает то же самое — но от запуска процесса.
    expect(gateway.status().usage[0]).toMatchObject({
      platformId: 'enterprise-platform',
      totalTokens: 12,
    });
  });

  it('ручная цена модели компании в прайсе панели — оценка считается по ней', async () => {
    // Решение по контуру №7: каталог Company цены Qwen3.8 не отдаёт, панель
    // оценивала 0 $ при списании 0,46 $. Цену вводят руками фрагментом имени.
    store.updateSettings({
      modelPricing: { 'qwen3.8': { input: 1, output: 4, cacheRead: 1, cacheWrite: 1 } },
    });
    const model = 'Qwen/Qwen3.8-27B-FP8';
    await gateway.start({
      store,
      appDataDir: appData,
      port: 0,
      fetchImpl: upstream([DELTA.replace('gpt-x', model), USAGE]),
      spendFlushMs: 0,
      pricing: gatewayPricing(store, { current: () => ({ entries: [] }) }),
    });
    port = gateway.status().port;
    await ask('/enterprise-platform/v1/chat/completions', { model, stream: true });

    const day = store.getPlatformSpend()['enterprise-platform']!.days[0]!;
    // 10 токенов входа по 1 $ и 2 выхода по 4 $ за миллион.
    expect(day.money.usd).toBeCloseTo((10 * 1 + 2 * 4) / 1_000_000, 9);
    expect(day.money.pricedTokens).toBe(12);
    expect(day.money.unpricedModels).toEqual([]);
  });

  it('«бюджет исчерпан» (402) пишется в учёт — это факт, а не наша оценка', async () => {
    await start(upstream(['{"error":{"message":"budget exceeded"}}'], 402));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBeGreaterThanOrEqual(400);

    const record = store.getPlatformSpend()['enterprise-platform']!;
    expect(record.exhaustedAt).toBeTruthy();
    // Что кончилось, контур не назвал — полей нет вовсе. Придумать их значило
    // бы сообщить человеку, что кончился лимит, о котором контур молчал.
    expect(record.exhaustedLevel).toBeUndefined();
    expect(record.exhaustedScope).toBeUndefined();
  });

  // Тело дословно из `inst-api/internal/api/handler_public_api.go:340`. На `/v1`
  // это ЕДИНСТВЕННЫЙ 402: трёхуровневый бюджет (`budget.go`) проверяется только
  // на JWT-маршрутах, куда панель не ходит. Что это бюджет ключа, говорит
  // манифест драйвера, а не шлюз.
  const KEY_BUDGET_402 =
    '{"error":{"message":"budget exceeded for this API key","type":"billing_error","code":"budget_exceeded"}}';

  it('402 платформы компании назван бюджетом КЛЮЧА — и в учёте, и в ответе клиенту', async () => {
    await start(upstream([KEY_BUDGET_402], 402));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });
    expect(answer.status).toBe(402);
    expect(answer.text).toMatch(/исчерпан бюджет ключа/i);
    expect(answer.text).not.toContain('не бюджет ключа');

    const record = store.getPlatformSpend()['enterprise-platform']!;
    expect(record.exhaustedScope).toBe('key');
    expect(record.exhaustedLevel).toBeUndefined();
  });

  it('новый отказ заменяет прежний целиком, а не наследует его уровень', async () => {
    await start(upstream([KEY_BUDGET_402], 402));
    store.savePlatformSpend({
      platformId: 'enterprise-platform',
      days: [],
      exhaustedAt: '2026-09-01T00:00:00.000Z',
      exhaustedLevel: 'team_monthly',
      exhaustedScope: 'limit',
    });
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    const record = store.getPlatformSpend()['enterprise-platform']!;
    expect(record.exhaustedScope).toBe('key');
    expect(record.exhaustedLevel).toBeUndefined();
  });

  // Найдено враждебным ревью Т8: 402 записывался только на пути чата, а список
  // моделей CLI спрашивает НА СТАРТЕ — то есть узнать об исчерпанном ключе
  // панель могла раньше первого чата и молча забывала.
  it('402 на списке моделей пишется в учёт так же, как на чате', async () => {
    await start(upstream(['{"error":{"message":"budget exceeded"}}'], 402));
    const answer = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/models`);
    expect(answer.status).toBeGreaterThanOrEqual(400);

    expect(store.getPlatformSpend()['enterprise-platform']!.exhaustedAt).toBeTruthy();
  });

  it('контур не прислал расход — дня в учёте не появляется', async () => {
    // Оборванный поток без кадра `usage`: считать нечего, а заведённый день
    // означал бы «в этот день что-то потратили».
    await start(brokenStream([DELTA], true));
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(store.getPlatformSpend()['enterprise-platform']).toBeUndefined();
  });

  it('остановка шлюза дописывает накопленный хвост', async () => {
    // Задержка настоящая: проверяем, что остановка не теряет последние секунды.
    await start(upstream([DELTA, USAGE]), { spendFlushMs: 60_000 });
    await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(store.getPlatformSpend()['enterprise-platform']).toBeUndefined();

    await gateway.stop();
    expect(store.getPlatformSpend()['enterprise-platform']!.days[0]!.totalTokens).toBe(12);
  });
});

/**
 * Прослойка инструментов через ВЕСЬ конвейер (Т5.2–Т5.4).
 *
 * Здесь проверяется не грамматика (её держит таблица форм в `tool-shim/`), а
 * то, ради чего прослойка написана: клиент, приславший инструменты, получает
 * НАСТОЯЩИЙ вызов в своём диалекте — иначе агент через контур остаётся чатом.
 */
describe('прослойка инструментов', () => {
  /** Ответ «модели»: текст, внутри которого лежит вызов по протоколу. */
  const CALL_TEXT =
    'Сейчас запишу файл. <tool_call>{"name": "Write", "arguments": {"file_path": "a.ts", "content": "x"}}</tool_call>';
  const callFrame = (text: string): string =>
    JSON.stringify({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: text } }] });
  const STOP = JSON.stringify({
    id: 'c1',
    model: 'gpt-x',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  const ANTHROPIC_ASK = {
    model: 'gpt-x',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'создай файл' }],
    tools: [
      {
        name: 'Write',
        description: 'пишет файл',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
      },
    ],
  };

  it('наверх уходят правила протокола, схемы и `tool_choice: "none"` (Т5.4)', async () => {
    await start(upstream([callFrame('готово'), USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });

    const sent = JSON.parse(calls[0]!.body) as {
      tools?: unknown;
      tool_choice?: string;
      messages: { role: string; content: string }[];
    };
    // Поля `tools` наверху нет вовсе: контур его не принимает, а лишний ключ он
    // выбросил бы молча — и разница между «не послали» и «пропало» исчезла бы.
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBe('none');
    const system = sent.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('<tool_call>');
    expect(system.content).toContain('### Write');
    expect(system.content).toContain('"file_path"');
  });

  it('диалект Anthropic, поток: клиент получает блок `tool_use` и `stop_reason: tool_use`', async () => {
    await start(upstream([callFrame(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', {
      ...ANTHROPIC_ASK,
      stream: true,
    });

    expect(answer.text).toContain('"type":"tool_use"');
    expect(answer.text).toContain('"name":"Write"');
    expect(answer.text).toContain(
      '"partial_json":"{\\"file_path\\":\\"a.ts\\",\\"content\\":\\"x\\"}"',
    );
    expect(answer.text).toContain('"stop_reason":"tool_use"');
    // Служебный блок клиенту не уезжает: он выполняет вызов, а не показывает
    // человеку его текст.
    expect(answer.text).not.toContain('<tool_call>');
    expect(answer.text).toContain('Сейчас запишу файл.');
  });

  it('диалект Anthropic, цельный ответ: вызов приходит блоком содержимого', async () => {
    await start(upstream([callFrame(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', ANTHROPIC_ASK);

    const body = JSON.parse(answer.text) as {
      content: { type: string; name?: string; input?: unknown }[];
      stop_reason: string;
    };
    expect(body.stop_reason).toBe('tool_use');
    const call = body.content.find((block) => block.type === 'tool_use');
    expect(call?.name).toBe('Write');
    expect(call?.input).toEqual({ file_path: 'a.ts', content: 'x' });
  });

  it('диалект OpenAI, поток: `tool_calls` и `finish_reason: tool_calls` (Т5.3)', async () => {
    await start(upstream([callFrame(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'создай файл' }],
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }],
      stream: true,
    });

    expect(answer.text).toContain('"tool_calls"');
    expect(answer.text).toContain('"name":"Write"');
    expect(answer.text).toContain('"finish_reason":"tool_calls"');
    expect(answer.text).not.toContain('<tool_call>');
  });

  it('диалект OpenAI, цельный ответ: вызов приходит полем сообщения', async () => {
    await start(upstream([callFrame(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'создай файл' }],
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }],
    });

    const body = JSON.parse(answer.text) as {
      choices: {
        message: {
          content: string;
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
        finish_reason: string;
      }[];
    };
    expect(body.choices[0]?.finish_reason).toBe('tool_calls');
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('Write');
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
      '{"file_path":"a.ts","content":"x"}',
    );
  });

  it('вызов, разрезанный контуром на два кадра, всё равно собирается', async () => {
    const cut = CALL_TEXT.indexOf('"Write"');
    await start(
      upstream([
        callFrame(CALL_TEXT.slice(0, cut)),
        callFrame(CALL_TEXT.slice(cut)),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', {
      ...ANTHROPIC_ASK,
      stream: true,
    });
    expect(answer.text).toContain('"type":"tool_use"');
    expect(answer.text).not.toContain('<tool_call>');
  });

  it('ход без вызова, но с заявкой о действии, помечен в следе (Т5.5)', async () => {
    await start(upstream([callFrame('Файл создан.'), STOP, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });

    const event = gateway.status().events[0];
    expect(event?.toolCalls).toBe(0);
    expect(event?.claimedWithoutCall).toBe(true);
  });

  it('испорченный блок вызовом не становится и назван в следе', async () => {
    await start(
      upstream([
        callFrame('<tool_call>{"name":"Bash","arguments":{}}</tool_call>'),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', {
      ...ANTHROPIC_ASK,
      stream: true,
    });

    expect(answer.text).not.toContain('"type":"tool_use"');
    // Человек видит и текст блока, и причину: инструмент не объявлялся клиентом.
    expect(answer.text).toContain('Bash');
    const event = gateway.status().events[0];
    expect(event?.toolCalls).toBe(0);
    expect(event?.toolFlaws.join(' ')).toContain('Bash');
  });

  it('прослойка выключена — конвейер работает ровно как до неё', async () => {
    writePlatform(store, { ...PLATFORM, toolShim: false });
    await start(upstream([callFrame(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', {
      ...ANTHROPIC_ASK,
      stream: true,
    });

    const sent = JSON.parse(calls[0]!.body) as { messages: { content: string }[] };
    expect(sent.messages[0]?.content).not.toContain('<tool_call>');
    // Текст вызова уезжает человеку как текст: прослойки нет, разбирать некому.
    expect(answer.text).toContain('tool_call');
    expect(answer.text).not.toContain('"type":"tool_use"');
    expect(gateway.status().events[0]?.toolCalls).toBe(0);
  });
});

/**
 * Метки защиты данных внутри вызова инструмента (Р11, Т5.7).
 *
 * Через контур аргумент едет замаскированным, и вернуться к CLI он обязан
 * значением: агент выполняет вызов сам, и метка вместо адреса или пути уедет не
 * на экран, а в файл — где человек найдёт её не сегодня.
 */
describe('метки защиты данных в вызове инструмента', () => {
  const ASK = {
    model: 'gpt-x',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'напиши письмо: Иванов' }],
    tools: [{ name: 'Write', description: 'пишет файл', input_schema: { type: 'object' } }],
    stream: true,
  };
  const STOP = JSON.stringify({
    id: 'c1',
    model: 'gpt-x',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  const callFrame = (args: unknown): string =>
    JSON.stringify({
      id: 'c1',
      model: 'gpt-x',
      choices: [
        {
          index: 0,
          delta: {
            content: `<tool_call>${JSON.stringify({ name: 'Write', arguments: args })}</tool_call>`,
          },
        },
      ],
    });

  /** Одно правило маскирования — ровно так его заводит человек. */
  function withRule(): void {
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    saveRules(appData, [
      {
        id: 'r1',
        name: 'Фамилии сотрудников',
        enabled: true,
        kind: 'terms',
        terms: ['Иванов'],
        pattern: '',
        action: 'mask',
        label: 'ИМЯ',
      },
    ]);
  }

  it('значение возвращается в аргументы вызова, а метка до клиента не доезжает', async () => {
    withRule();
    await start(
      upstream([
        callFrame({ file_path: 'letter.md', content: 'здравствуйте, [ИМЯ_1.1]' }),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', ASK);

    // Наверх ушла метка.
    expect(calls[0]?.body).not.toContain('Иванов');
    expect(calls[0]?.body).toContain('[ИМЯ_1.1]');
    // А в вызове у клиента — значение, и вызов разбирается как JSON.
    expect(answer.text).toContain('"type":"tool_use"');
    expect(answer.text).not.toContain('[ИМЯ_1');
    const json = partialJson(answer.text);
    expect(JSON.parse(json)).toEqual({ file_path: 'letter.md', content: 'здравствуйте, Иванов' });
  });

  it('путь с обратными косыми не ломает упакованный JSON вызова', async () => {
    store.updateSettings({ dlp: { ...store.getSettings().dlp, enabled: true } });
    saveRules(appData, [
      {
        id: 'r2',
        name: 'Путь в профиле',
        enabled: true,
        kind: 'regex',
        terms: [],
        pattern: 'C:\\\\Users\\\\[A-Za-z0-9_.-]+',
        action: 'mask',
        label: 'ПУТЬ',
      },
    ]);
    await start(
      upstream([
        callFrame({ file_path: '[ПУТЬ_1.1]\\notes.md', content: 'готово' }),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', {
      ...ASK,
      messages: [{ role: 'user', content: 'запиши в C:\\Users\\rusyander' }],
    });

    // Разбор — и есть проверка: неэкранированная косая делает вызов
    // неразбираемым целиком, и агент молча не делает ничего.
    expect(JSON.parse(partialJson(answer.text))).toEqual({
      file_path: 'C:\\Users\\rusyander\\notes.md',
      content: 'готово',
    });
  });

  it('метка, которой панель не выдавала, останавливает ход и названа в следе', async () => {
    withRule();
    await start(
      upstream([callFrame({ file_path: 'a.md', content: 'пишу [ИМЯ_9]' }), STOP, USAGE, '[DONE]']),
    );
    const answer = await ask('/enterprise-platform/v1/messages', ASK);

    expect(answer.text).not.toContain('"type":"tool_use"');
    expect(answer.text).toContain('метку защиты данных');
    expect(answer.text).toContain('[ИМЯ_9]');
    const event = gateway.status().events[0];
    expect(event?.toolFlaws.join(' ')).toContain('mask-unrestorable');
    expect(event?.toolCalls).toBe(0);
  });

  it('та же остановка приходит цельным телом, если клиент не просил поток', async () => {
    withRule();
    store.updateSettings({
      platformGateway: { ...store.getSettings().platformGateway, forceStream: true },
    });
    await start(
      upstream([callFrame({ file_path: 'a.md', content: 'пишу [ИМЯ_9]' }), STOP, USAGE, '[DONE]']),
    );
    const answer = await ask('/enterprise-platform/v1/messages', { ...ASK, stream: false });

    expect(answer.status).toBe(400);
    expect(answer.text).toContain('метку защиты данных');
    // Причина названа своя, а не «проверки контура»: контур тут ни при чём.
    expect(answer.text).not.toContain('Проверки контента контура');
  });

  it('карта подмены контура разворачивается ДО синтеза вызова', async () => {
    await start(
      upstream([
        JSON.stringify({ platform_deanonymized_entities: { ORG_7: 'Компания' } }),
        callFrame({ file_path: 'a.md', content: 'заказчик ORG_7' }),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', ASK);

    expect(JSON.parse(partialJson(answer.text))).toEqual({
      file_path: 'a.md',
      content: 'заказчик Компания',
    });
    // Сам вендорный кадр клиенту по-прежнему не уезжает.
    expect(answer.text).not.toContain('platform_deanonymized_entities');
    expect(gateway.status().events[0]?.masked).toBe(true);
  });
});

/**
 * Правила контура (Т7) на НАСТОЯЩЕМ проводе.
 *
 * Табличный тест доказывает, что чистая функция кладёт поле в объект; здесь
 * проверяется единственное, что имеет значение для человека, — что это поле
 * доехало до тела запроса, которое шлюз отправил наверх. Между тем и другим
 * стоят перевод диалекта, защита данных и пересборка тела в поток, и любое из
 * них могло бы поле потерять.
 */
describe('правила контура в теле запроса (Т7)', () => {
  const ASK_SIMPLE = {
    model: 'gpt-x',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'привет' }],
    stream: true,
  };

  /** Тело, которое шлюз отправил контуру. */
  const sent = (): Record<string, unknown> =>
    JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;

  it('ни одно правило не задано — ни одного поля контура в теле нет', async () => {
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);

    const body = sent();
    expect(body.platform_tools).toBeUndefined();
    expect(body.platform_tool_mode).toBeUndefined();
    expect(body.generation_preset).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    // Кроме одного: выключения. Обычное сообщение без инструментов клиента —
    // самый частый запрос панели, и до ревью Т7 (M2) контур получал в нём полную
    // свободу пользоваться своими инструментами, пока карточка обещала обратное.
    expect(body.tool_choice).toBe('none');
  });

  it('заданные инструменты контура снимают выключение', async () => {
    writePlatform(store, {
      ...PLATFORM,
      toolShim: false,
      rules: {
        ...PLATFORM.rules,
        platform: { ...defaultPlatformRules(), platformTools: ['web_search'] },
      },
    });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);

    expect(sent().tool_choice).toBeUndefined();
  });

  it('имена инструментов контура и режим цикла уезжают вместе', async () => {
    writePlatform(store, {
      ...PLATFORM,
      // Прослойка снята: два набора на один ход — взаимное исключение, и
      // обычной дорогой такое состояние не сохранить.
      toolShim: false,
      rules: {
        ...PLATFORM.rules,
        platform: {
          ...defaultPlatformRules(),
          platformTools: ['web_search'],
          toolMode: 'single_turn',
        },
      },
    });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);

    expect(sent().platform_tools).toEqual(['web_search']);
    expect(sent().platform_tool_mode).toBe('single_turn');
  });

  it('пресет генерации и размышления — своими полями', async () => {
    writePlatform(store, {
      ...PLATFORM,
      rules: {
        ...PLATFORM.rules,
        platform: {
          ...defaultPlatformRules(),
          generationPreset: 'creative',
          enableThinking: 'off',
        },
      },
    });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);

    expect(sent().generation_preset).toBe('creative');
    // Поле контура — вложенное (`schemas.py:120`), верхнего уровня он не знает.
    expect(sent().chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sent()).not.toHaveProperty('enable_thinking');
  });

  /**
   * Режим `single_turn` обещает вернуть вызов КЛИЕНТУ, а `claude.exe` говорит на
   * диалекте Anthropic. До ревью Т7 (M1) он получал `stop_reason: tool_use` и ни
   * одного блока `tool_use`: ответ, невалидный по протоколу, — и ни строки о
   * потере ни в следе, ни на экране.
   */
  const CONTOUR_CALL = [
    '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"content":"сейчас поищу"}}]}',
    '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7","type":"function","function":{"name":"web_search","arguments":"{\\"query\\":"}}]}}]}',
    '{"id":"c1","model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"погода\\"}"}}]},"finish_reason":"tool_calls"}]}',
  ];

  /**
   * Контур с поведением `mod-llmbox/.../chat/router.py:237-243`: `single_turn`
   * с `stream: true` — 400 с FastAPI `detail`, без потока — цельное тело, где
   * вызов лежит в `message.tool_calls` целиком, а не кусками.
   */
  const singleTurnContour: PlatformFetch = (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ?? '',
    });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (body.platform_tool_mode === 'single_turn' && body.stream === true) {
      return Promise.resolve(
        new Response(
          '{"detail":"platform_tool_mode=single_turn is not supported with stream=true"}',
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'c1',
          model: 'gpt-x',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'сейчас поищу',
                tool_calls: [
                  {
                    id: 'call_7',
                    type: 'function',
                    function: { name: 'web_search', arguments: '{"query":"погода"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  };

  const singleTurn = (): void => {
    writePlatform(store, {
      ...PLATFORM,
      toolShim: false,
      rules: {
        ...PLATFORM.rules,
        platform: {
          ...defaultPlatformRules(),
          platformTools: ['web_search'],
          toolMode: 'single_turn',
        },
      },
    });
  };

  it('вызов, сделанный самим контуром, доезжает до клиента диалекта Anthropic', async () => {
    singleTurn();
    await start(upstream([...CONTOUR_CALL, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);
    assertAnthropicContourCall(answer.text);
  });

  it('single_turn уходит наверх НЕ потоком: иначе контур отвечает 400', async () => {
    singleTurn();
    await start(singleTurnContour);
    const answer = await ask('/enterprise-platform/v1/messages', ASK_SIMPLE);

    expect(sent().stream).not.toBe(true);
    expect(sent().stream_options).toBeUndefined();
    expect(answer.status).toBe(200);
    // Клиент просил поток — и получает поток, собранный из цельного тела.
    assertAnthropicContourCall(answer.text);
  });

  it('single_turn цельным телом: вызов доезжает и до клиента диалекта OpenAI', async () => {
    singleTurn();
    await start(singleTurnContour);
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
      messages: [{ role: 'user', content: 'погода?' }],
    });

    expect(answer.status).toBe(200);
    expect(answer.text).toContain('"tool_calls"');
    expect(answer.text).toContain('"name":"web_search"');
    expect(answer.text).toContain('"id":"call_7"');
    expect(gateway.status().events[0]?.contourCalls).toBe(1);
  });

  it('FastAPI `detail` отказа доезжает до клиента, а не голое «не принял»', async () => {
    await start(
      wholeBodyStatus(
        400,
        '{"detail":"platform_tool_mode=single_turn is not supported for image-generation models"}',
      ),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      stream: true,
    });

    expect(answer.status).toBe(400);
    expect(answer.text).toContain('not supported for image-generation models');
  });

  function assertAnthropicContourCall(answer: string): void {
    // Блок вызова, а не только причина остановки: клиент собирает вызов из него.
    expect(answer).toContain('"type":"tool_use"');
    expect(answer).toContain('"name":"web_search"');
    expect(answer).toContain('"id":"call_7"');
    // Аргументы (кусками или целиком) склеены в один JSON.
    expect(partialJson(answer)).toBe('{"query":"погода"}');
    expect(answer).toContain('"stop_reason":"tool_use"');
    // Текст ответа не потерян и его блок закрыт ДО блока вызова.
    const text = answer.indexOf('"text_delta"');
    const call = answer.indexOf('"type":"tool_use"');
    expect(text).toBeGreaterThan(-1);
    expect(text).toBeLessThan(call);
    // Вызов контура считается отдельно от вызовов прослойки: сводка «инструменты
    // через контур» считается по `toolCalls`, и чужая работа в ней была бы ложью.
    const event = gateway.status().events[0];
    expect(event?.contourCalls).toBe(1);
    expect(event?.toolCalls).toBe(0);
  }

  it('тот же вызов цельным телом: клиент, просивший не поток, его тоже получает', async () => {
    singleTurn();
    await start(singleTurnContour);
    const answer = await ask('/enterprise-platform/v1/messages', { ...ASK_SIMPLE, stream: false });
    const body = JSON.parse(answer.text) as {
      content: { type: string; name?: string; input?: unknown }[];
      stop_reason: string;
    };

    expect(body.content.find((block) => block.type === 'tool_use')).toMatchObject({
      name: 'web_search',
      input: { query: 'погода' },
    });
    expect(body.stop_reason).toBe('tool_use');
  });

  it('инструменты контура сильнее прослойки, и уступка НАЗВАНА в следе', async () => {
    // Состояние, в которое обычной дорогой не попасть (сохранение откажет), —
    // его приносит разворот чужого архива. Молча выбрать одну из сторон здесь
    // значило бы оставить человека с агентом, который говорит, но не делает.
    writePlatform(store, {
      ...PLATFORM,
      toolShim: true,
      rules: {
        ...PLATFORM.rules,
        platform: { ...defaultPlatformRules(), platformTools: ['web_search'] },
      },
    });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', {
      ...ASK_SIMPLE,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    });

    const body = sent();
    expect(body.platform_tools).toEqual(['web_search']);
    // Прослойка молчит: текста протокола в теле нет, и «tools: shimmed» тоже.
    expect(JSON.stringify(body)).not.toContain('Протокол вызова инструментов');
    expect(JSON.stringify(body)).not.toContain('tool_call');
    const event = gateway.status().events[0];
    expect(event?.shimmed).toEqual([]);
    // Имя поля, ровно один раз: `toContain` пропускал дубль, а фраза в списке
    // имён полей читалась как имя (ревью Т7, m4).
    expect(event?.lost.filter((field) => field === 'tools')).toEqual(['tools']);
    expect(event?.lost.some((field) => field.includes(' '))).toBe(false);
  });
});

/**
 * Инструменты полем у совместимого шлюза (аудит DRV-01): настоящий слушатель,
 * настоящий HTTP от «CLI», заглушка на месте сети. До правки мост выбрасывал
 * `tools` у ЛЮБОГО драйвера, и Claude Code через vLLM/OpenRouter оставался без
 * рук, хотя шлюз вызовы умеет.
 */
describe('инструменты клиента полем (совместимый шлюз)', () => {
  const COMPAT: Platform = { ...PLATFORM, id: 'vllm', driver: 'openai-compat', toolShim: false };
  const sent = (): Record<string, unknown> =>
    JSON.parse(calls.at(-1)?.body ?? '{}') as Record<string, unknown>;

  const NATIVE_CALL = [
    '{"id":"c2","model":"qwen","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"Write","arguments":"{\\"file_path\\":"}}]}}]}',
    '{"id":"c2","model":"qwen","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}',
  ];

  const TURN = {
    model: 'qwen',
    max_tokens: 100,
    stream: true,
    tools: [{ name: 'Write', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'создай a.ts' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'b.ts' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  };

  beforeEach(() => {
    writePlatform(store, COMPAT);
    writeToken(appData, COMPAT.id, SECRET);
  });

  it('Anthropic-клиент: схемы и история уходят полями, вызов шлюза возвращается блоком', async () => {
    await start(upstream([...NATIVE_CALL, USAGE, '[DONE]']));
    const answer = await ask('/vllm/v1/messages', TURN);

    expect(sent().tools).toEqual([
      { type: 'function', function: { name: 'Write', parameters: { type: 'object' } } },
    ]);
    expect(sent().messages).toEqual([
      { role: 'user', content: 'создай a.ts' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'Write', arguments: '{"file_path":"b.ts"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
    ]);
    // Текста протокола прослойки в теле нет: руки идут полем.
    expect(JSON.stringify(sent())).not.toContain('tool_call>');

    expect(answer.status).toBe(200);
    expect(answer.text).toContain('"type":"tool_use"');
    expect(answer.text).toContain('"name":"Write"');
    expect(answer.text).toContain('"id":"call_9"');
    expect(partialJson(answer.text)).toBe('{"file_path":"a.ts"}');
    expect(answer.text).toContain('"stop_reason":"tool_use"');

    const event = gateway.status().events[0];
    expect(event?.lost).toEqual([]);
    expect(event?.shimmed).toEqual([]);
    // Вызов — руки агента, а не набор платформы.
    expect(event?.nativeCalls).toBe(1);
    expect(event?.contourCalls).toBe(0);
  });

  it('OpenAI-клиент: инструменты уходят как пришли, выбор не снимается', async () => {
    await start(upstream([...NATIVE_CALL, USAGE, '[DONE]']));
    const tools = [{ type: 'function', function: { name: 'Write', parameters: {} } }];
    const answer = await ask('/vllm/v1/chat/completions', {
      model: 'qwen',
      stream: true,
      tools,
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'создай a.ts' }],
    });

    expect(sent().tools).toEqual(tools);
    expect(sent().tool_choice).toBe('auto');
    expect(answer.text).toContain('"tool_calls"');
    expect(gateway.status().events[0]?.lost).toEqual([]);
  });

  it('прослойка, включённая человеком, сильнее манифеста и не шлёт выбор без `tools`', async () => {
    writePlatform(store, { ...COMPAT, toolShim: true });
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/vllm/v1/messages', { ...TURN, tool_choice: { type: 'auto' } });

    expect(sent()).not.toHaveProperty('tools');
    // `none` — знание платформы компании о СВОИХ инструментах; строгий шлюз на выбор без
    // `tools` отвечает 400 вместо хода.
    expect(sent()).not.toHaveProperty('tool_choice');
    expect(JSON.stringify(sent())).toContain('tool_call>');
    expect(gateway.status().events[0]?.shimmed).toEqual([
      'content[].tool_use / tool_result',
      'tools',
      'tool_choice',
    ]);
  });
});

/** Аргументы вызова из потока Anthropic: их везёт единственная `input_json_delta`. */
function partialJson(stream: string): string {
  for (const line of stream.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6)) as {
      delta?: { type?: string; partial_json?: string };
    };
    if (event.delta?.type === 'input_json_delta') return event.delta.partial_json ?? '';
  }
  return '';
}

/**
 * Поле, которое платформа принимает под ДРУГИМ именем (DRV-18). До задачи
 * судьба `renamed` была словом манифеста без кода за ним: строку можно было
 * объявить, а наверх поле уезжало под старым именем, и шлюз, ждущий новое,
 * молча отвечал без потолка вывода. Переименование — последний шаг сборки тела,
 * в обоих диалектах клиента: полям прослойки и моста оно тоже достаётся.
 */
describe('переименованные поля запроса', () => {
  const driver = driverFor('enterprise-platform');
  const declared = driver.requestFields;
  afterEach(() => {
    driver.requestFields = declared;
  });

  function renameMaxTokens(): void {
    driver.requestFields = [
      ...declared,
      {
        dialect: 'openai',
        field: 'max_tokens',
        fate: 'renamed',
        to: 'max_completion_tokens',
        note: 'шлюз принимает потолок вывода под новым именем',
      },
    ];
  }

  it('anthropic-клиент: наверх уходит новое имя, старого нет', async () => {
    renameMaxTokens();
    await start(upstream([DELTA, USAGE, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', {
      model: 'gpt-x',
      max_tokens: 77,
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(answer.status).toBe(200);
    const sent = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(sent.max_completion_tokens).toBe(77);
    expect(sent).not.toHaveProperty('max_tokens');
  });

  it('openai-клиент: то же самое, и явное новое имя клиента не затирается', async () => {
    renameMaxTokens();
    await start(upstream([DELTA, USAGE, '[DONE]']));
    await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      max_tokens: 77,
      messages: [{ role: 'user', content: 'привет' }],
    });
    await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      max_tokens: 77,
      max_completion_tokens: 12,
      messages: [{ role: 'user', content: 'привет' }],
    });
    const first = JSON.parse(calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(first.max_completion_tokens).toBe(77);
    expect(first).not.toHaveProperty('max_tokens');
    const second = JSON.parse(calls[1]?.body ?? '{}') as Record<string, unknown>;
    expect(second.max_completion_tokens).toBe(12);
    expect(second).not.toHaveProperty('max_tokens');
  });
});

/**
 * Сколько шлюз ждёт ЦЕЛЬНЫЙ ответ — число из манифеста драйвера, а не 120 с
 * одной платформы, зашитые в шлюз (DRV-18). Шлюз с пределом в 30 с при зашитых
 * 125 держал клиента на линии ещё полторы минуты после того, как контур уже
 * оборвал вызов; шлюз с пределом в 10 минут обрывался панелью на законном
 * длинном ходе. Предел подменён на время теста крошечным, чтобы «не дождались»
 * проверялось секундами: к объявленному прибавляется запас в 5 с.
 */
describe('ожидание цельного ответа по манифесту', () => {
  const driver = driverFor('enterprise-platform');
  const declared = driver.nonStreamTimeoutSec;
  afterEach(() => {
    driver.nonStreamTimeoutSec = declared;
  });

  /** Контур, отвечающий через 7 с и честно прерываемый сигналом. */
  const slowContour: PlatformFetch = (url, init) => {
    calls.push({ url, headers: {}, body: init?.body ?? '' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(
          new Response(
            JSON.stringify({
              id: 'c1',
              model: 'gpt-x',
              choices: [
                { index: 0, message: { role: 'assistant', content: 'ок' }, finish_reason: 'stop' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }, 7_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error('aborted'));
      });
    });
  };

  it('объявленный предел плюс запас истёк — 502 с этим числом, а не ожидание 125 с', async () => {
    driver.nonStreamTimeoutSec = 0.01;
    const gatewaySettings = store.getSettings().platformGateway;
    store.updateSettings({ platformGateway: { ...gatewaySettings, forceStream: false } });
    await start(slowContour);
    const answer = await ask('/enterprise-platform/v1/chat/completions', {
      model: 'gpt-x',
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('не начал отвечать за 5.01 с');
  }, 15_000);
});
