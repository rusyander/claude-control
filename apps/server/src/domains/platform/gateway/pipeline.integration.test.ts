import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { saveRules } from '../../dlp/rules-store.ts';
import { writePlatform, writeToken } from '../store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { PlatformGateway } from './listener.ts';

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
  title: 'EnterprisePlatform · dev',
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
  caCertPath: '',
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

/** Контур, умерший на полуслове: кадры кончились обрывом, а не `[DONE]`. */
function brokenStream(frames: string[], fail: boolean): PlatformFetch {
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
  options: { spendFlushMs?: number } = {},
): Promise<void> {
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl,
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
        '{"enterprise-platform_status":"thinking"}',
        '{"enterprise-platform_status":"summarizing"}',
        '{"enterprise-platform_reasoning":"я думаю"}',
        DELTA,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    expect(answer.text).not.toContain('enterprise-platform_');
    expect(answer.text).toContain('"content":"да"');
    expect(answer.text.trimEnd().endsWith('data: [DONE]')).toBe(true);

    const status = gateway.status();
    expect(status.usage[0]).toMatchObject({ platformId: 'enterprise-platform', totalTokens: 12, requests: 1 });
    // Денег в журнале шлюза нет: «внутренняя единица контура» была выдумкой.
    expect(status.usage[0]).not.toHaveProperty('unitUsd');
    expect(status.events[0]).toMatchObject({ summarized: true, stages: expect.any(Array) });
    expect(status.events[0]?.stages).toEqual(['thinking', 'summarizing']);
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
});

describe('отказы контура', () => {
  it('451 в потоке приходит клиенту терминальной ошибкой, панели — перечнем', async () => {
    await start(
      upstream([
        DELTA,
        '{"enterprise-platform_guardrails":{"stream_interrupted":true,"violations":[{"category":"pii_phone","text":"телефон 89001234567"}]}}',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

    expect(answer.text).toContain('content_policy_violation');
    expect(answer.text).toContain('pii_phone');
    // Проверявшийся текст не уходит ни клиенту, ни в след панели.
    expect(answer.text).not.toContain('89001234567');
    const event = gateway.status().events[0];
    expect(event?.violations).toEqual(['pii_phone']);
    expect(JSON.stringify(event)).not.toContain('89001234567');
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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
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
    const streamed = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    await gateway.stop();

    await start(upstream(body, 451));
    const plain = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: false });

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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

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
        '{"enterprise-platform_sanitized":{"violations":[{"category":"pii_email","text":"ivanov@corp.ru"}]}}',
        DELTA,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('Нет связи с контуром');
    expect(gateway.status().failures).toBe(1);
  });

  it('402 приходит своим кодом и русской причиной контура', async () => {
    await start(upstream([JSON.stringify({ error: { message: 'Бюджет ключа исчерпан' } })], 402));
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
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
      model: 'enterprise-platform-opus-x',
      stream: true,
    });
    expect(answer.status).toBe(403);
    expect(answer.text).toContain('enterprise-platform-opus-x');
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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'ушедшая', stream: true });
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
        '{"id":"c1","choices":[{"index":0,"delta":{"content":"нашёл [ИМЯ_1]"}}]}',
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
    expect(calls[0]?.body).toContain('[ИМЯ_1]');
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

    expect(answer.status).toBe(403);
    expect(answer.text).toContain('Фамилии сотрудников');
    expect(calls).toHaveLength(0);
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
        enterprise-platform_sanitized: { violations: [{ category: 'pii_phone' }] },
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
        enterprise-platform_tools_unavailable: true,
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
    expect(answer.text).not.toContain('enterprise-platform_tools_unavailable');
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
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });

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
    await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/chat/completions?key=sk-secret-in-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', stream: true }),
    });

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
    expect(gateway.status().usage[0]).toMatchObject({ platformId: 'enterprise-platform', totalTokens: 12 });
  });

  it('«бюджет исчерпан» (402) пишется в учёт — это факт, а не наша оценка', async () => {
    await start(upstream(['{"error":{"message":"budget exceeded"}}'], 402));
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(answer.status).toBeGreaterThanOrEqual(400);

    const record = store.getPlatformSpend()['enterprise-platform']!;
    expect(record.exhaustedAt).toBeTruthy();
    // Уровня контур не назвал — поля нет вовсе. Придумать его значило бы
    // сообщить человеку, что кончился лимит, о котором контур молчал.
    expect(record.exhaustedLevel).toBeUndefined();
  });

  // 402 у контура приходит с ТРЁХ уровней (`inst-api/internal/budget/budget.go`:
  // дневной лимит пользователя, месячный команды, месячный инстанса), и бюджета
  // КЛЮЧА среди них нет — его исчерпание контур отдаёт кодом 401. Без разбора
  // уровня карточка сообщала бы, что кончилось не то, что кончилось.
  it('уровень лимита из тела 402 доезжает до учёта', async () => {
    await start(
      upstream(['{"error":{"message":"budget exceeded: user_daily","type":"billing_error"}}'], 402),
    );
    const answer = await ask('/enterprise-platform/v1/chat/completions', { model: 'gpt-x', stream: true });
    expect(answer.status).toBe(402);

    expect(store.getPlatformSpend()['enterprise-platform']!.exhaustedLevel).toBe('user_daily');
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
    const answer = await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });

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
    const answer = await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });
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
    const answer = await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });

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
    const answer = await ask('/enterprise-platform/v1/messages', { ...ANTHROPIC_ASK, stream: true });

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
        callFrame({ file_path: 'letter.md', content: 'здравствуйте, [ИМЯ_1]' }),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', ASK);

    // Наверх ушла метка.
    expect(calls[0]?.body).not.toContain('Иванов');
    expect(calls[0]?.body).toContain('[ИМЯ_1]');
    // А в вызове у клиента — значение, и вызов разбирается как JSON.
    expect(answer.text).toContain('"type":"tool_use"');
    expect(answer.text).not.toContain('[ИМЯ_1]');
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
        callFrame({ file_path: '[ПУТЬ_1]\\notes.md', content: 'готово' }),
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
        JSON.stringify({ enterprise-platform_deanonymized_entities: { ORG_7: 'Платформа компании' } }),
        callFrame({ file_path: 'a.md', content: 'заказчик ORG_7' }),
        STOP,
        USAGE,
        '[DONE]',
      ]),
    );
    const answer = await ask('/enterprise-platform/v1/messages', ASK);

    expect(JSON.parse(partialJson(answer.text))).toEqual({
      file_path: 'a.md',
      content: 'заказчик Платформа компании',
    });
    // Сам вендорный кадр клиенту по-прежнему не уезжает.
    expect(answer.text).not.toContain('enterprise-platform_deanonymized_entities');
    expect(gateway.status().events[0]?.masked).toBe(true);
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
