import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { saveRules } from '../../dlp/rules-store.ts';
import { writePlatform, writeToken } from '../store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { driverFor } from '../drivers/index.ts';
import { PlatformGateway } from './listener.ts';

/**
 * Платформа, говорящая на диалекте Anthropic сама (DRV-07).
 *
 * До задачи клиент Anthropic шёл к любому контуру только мостом в OpenAI, и
 * размышления, метки кэша и подписанные блоки терялись даже там, где шлюз
 * (LiteLLM `/v1/messages`, прокси Bedrock, корпоративный шлюз Anthropic-вида)
 * принял бы их как есть. Здесь проверяется то, что уходит в сеть, — настоящий
 * слушатель, настоящий HTTP от «CLI»; подменён только ответ платформы.
 *
 * Манифест драйвера подменён на время теста тем же объектом, который читает
 * конвейер: встроенные драйверы родной ручки не объявляют, а реестр закрыт.
 */

const SECRET = 'platform-token-4d1a7c9e2b6f0';

const PLATFORM: Platform = {
  id: 'enterprise-platform',
  title: 'Шлюз Anthropic-вида',
  driver: 'enterprise-platform',
  baseUrl: 'https://llm.example.ru',
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
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

/** Поток сообщения Anthropic: расход в начале и в конце, как у настоящего API. */
const EVENTS: Array<[string, unknown]> = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [],
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          output_tokens: 1,
        },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'да' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 7 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

const ASK = {
  model: 'claude-x',
  max_tokens: 100,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 50 },
  system: [{ type: 'text', text: 'будь краток', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'Read', description: 'читает файл', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'привет' }],
};

const CLIENT_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'interleaved-thinking-2025-05-14',
  'x-api-key': 'client-dummy-key',
};

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

const driver = driverFor('enterprise-platform');
const declared = { ...driver };

function sse(events: Array<[string, unknown]>): string {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
}

function platformAnswers(text: string, type = 'text/event-stream', status = 200): PlatformFetch {
  return (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    });
    return Promise.resolve(new Response(text, { status, headers: { 'content-type': type } }));
  };
}

async function start(fetchImpl: PlatformFetch): Promise<void> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  port = gateway.status().port;
}

async function ask(
  body: unknown,
  headers: Record<string, string> = CLIENT_HEADERS,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function sent(index = 0): Record<string, unknown> {
  return JSON.parse(calls[index]?.body ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-native-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, SECRET);
  gateway = new PlatformGateway();
  calls = [];
  Object.assign(driver, { anthropic: { messages: 'messages' } });
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
  Object.assign(driver, { anthropic: declared.anthropic });
});

describe('родной диалект Anthropic у платформы', () => {
  it('тело уходит на объявленную ручку как есть: размышления, кэш и инструменты целы', async () => {
    await start(platformAnswers(sse(EVENTS)));
    const answer = await ask(ASK);

    expect(answer.status).toBe(200);
    expect(calls[0]?.url).toBe('https://llm.example.ru/v1/messages');
    expect(sent().thinking).toEqual(ASK.thinking);
    expect(sent().system).toEqual(ASK.system);
    // Инструменты — полем своего диалекта, без протокола прослойки в системной строке.
    expect(sent().tools).toEqual(ASK.tools);
    expect(JSON.stringify(sent().system)).not.toContain('tool_call');
  });

  it('наверх едут ключ контура и два заголовка протокола, ключ клиента — нет', async () => {
    await start(platformAnswers(sse(EVENTS)));
    await ask(ASK);

    const headers = calls[0]?.headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(Object.values(headers)).not.toContain('client-dummy-key');
  });

  it('версия протокола не прислана — уходит та, без которой ручка не отвечает', async () => {
    await start(platformAnswers(sse(EVENTS)));
    await ask(ASK, {});
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers).not.toHaveProperty('anthropic-beta');
  });

  it('поток доезжает кадрами платформы, расход учтён с кэшем, след назвал вызов', async () => {
    await start(platformAnswers(sse(EVENTS)));
    const answer = await ask(ASK);

    expect(answer.text).toBe(sse(EVENTS));
    const day = store.getPlatformSpend()['enterprise-platform']!.days[0]!;
    // Вход — вместе с прочитанным и записанным кэшем: это токены, которые
    // платформа обработала и списала.
    expect(day.promptTokens).toBe(18);
    expect(day.completionTokens).toBe(7);
    expect(day.totalTokens).toBe(25);
    expect(gateway.status().events[0]).toMatchObject({
      status: 200,
      dialect: 'anthropic',
      totalTokens: 25,
      toolCalls: 1,
      lost: [],
      shimmed: [],
    });
  });

  it('не поток: цельное сообщение как есть, расход из его usage', async () => {
    const message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-x',
      content: [{ type: 'text', text: 'готово' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 2 },
    };
    await start(platformAnswers(JSON.stringify(message), 'application/json'));
    const answer = await ask({ ...ASK, stream: false });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual(message);
    expect(sent().stream).toBe(false);
    expect(calls[0]?.headers.accept).toBe('application/json');
    expect(gateway.status().events[0]).toMatchObject({ status: 200, totalTokens: 6 });
    expect(gateway.status().events[0]).not.toHaveProperty('usageUnreported');
  });

  it('сообщение без usage — след говорит «расход не сообщён», а не молчаливый ноль', async () => {
    // Аудит MD-09: ноль в расходе читался как «бесплатно», хотя платформа просто
    // не прислала счёт. Ответ настоящий, значит токены были.
    const message = {
      id: 'msg_3',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'готово' }],
      stop_reason: 'end_turn',
    };
    await start(platformAnswers(JSON.stringify(message), 'application/json'));
    await ask({ ...ASK, stream: false });

    expect(gateway.status().events[0]).toMatchObject({
      status: 200,
      totalTokens: 0,
      usageUnreported: true,
    });
  });

  it('ошибка кадром посреди потока — клиент её видит, след называет причину и код', async () => {
    const broken = sse([
      EVENTS[0]!,
      ['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
    ]);
    await start(platformAnswers(broken));
    const answer = await ask(ASK);

    expect(answer.text).toContain('overloaded_error');
    expect(gateway.status().events[0]).toMatchObject({ status: 503 });
    expect(gateway.status().events[0]?.error).toContain('Overloaded');
  });

  it('поток оборвался без message_stop — клиенту кадр ошибки, а не короткий «удачный» ответ', async () => {
    await start(platformAnswers(sse(EVENTS.slice(0, 3))));
    const answer = await ask(ASK);

    expect(answer.text).toContain('event: error');
    expect(gateway.status().events[0]).toMatchObject({ status: 502 });
  });

  it('защита данных маскирует тело Anthropic-вида и разворачивает метку в ответе', async () => {
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
    const reply = sse([
      EVENTS[0]!,
      EVENTS[1]!,
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'нашёл [ИМЯ_1.1]' },
        },
      ],
      ...EVENTS.slice(3),
    ]);
    await start(platformAnswers(reply));
    const answer = await ask({ ...ASK, messages: [{ role: 'user', content: 'кто такой Иванов' }] });

    expect(calls[0]?.body).not.toContain('Иванов');
    expect(calls[0]?.body).toContain('[ИМЯ_1.1]');
    expect(answer.text).toContain('нашёл Иванов');
  });

  it('человек включил прослойку — запрос идёт мостом, как шёл', async () => {
    writePlatform(store, { ...PLATFORM, toolShim: true });
    await start(
      platformAnswers(
        'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"да"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    await ask(ASK);
    expect(calls[0]?.url).toBe('https://llm.example.ru/v1/chat/completions');
  });

  it('подпись моста диалектов гаснет, когда мост не нужен ни одному включённому контуру', async () => {
    await start(platformAnswers(sse(EVENTS)));
    expect(gateway.status().compromises).not.toContain('dialect-bridge');
    writePlatform(store, { ...PLATFORM, toolShim: true });
    expect(gateway.status().compromises).toContain('dialect-bridge');
  });

  it('инструменты платформы включены — клиентские сняты и названы потерей', async () => {
    writePlatform(store, {
      ...PLATFORM,
      rules: {
        ...PLATFORM.rules,
        platform: { ...defaultPlatformRules(), platformTools: ['web_search'] },
      },
    });
    await start(platformAnswers(sse(EVENTS)));
    await ask(ASK);

    expect(calls[0]?.url).toBe('https://llm.example.ru/v1/messages');
    expect(sent()).not.toHaveProperty('tools');
    expect(gateway.status().events[0]?.lost).toEqual(['tools']);
  });
});
