import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../../lib/app-store/app-store.ts';
import { writePlatform, writeToken } from '../../store/store.ts';
import type { PlatformFetch } from '../../ca-fetch/ca-fetch.ts';
import type { PricingLookup } from '../../../analytics/pricing.ts';
import { budgetVerdict } from '../../spend/spend.ts';
import { saveRules } from '../../../dlp/rules-store.ts';
import { PlatformGateway } from '../listener/listener.ts';

/**
 * Кэш промпта Claude через контур (n4): пометки `cache_control` уезжают наверх у
 * моделей, которым драйвер их объявил, а запись в кэш доезжает до транскрипта CLI.
 *
 * Весь путь шлюза: настоящий слушатель, HTTP от «CLI», подставленный контур. Числа
 * расхода — с живого замера 22.10.2026 (haiku через платформу компании, поток с
 * `include_usage`): запись 9712 часовая, вход 16, затем чтение 9712.
 */

const SECRET = 'platform-token-cache-5d1e';

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

const DELTA =
  '{"id":"c1","model":"claude-haiku-5-5","choices":[{"index":0,"delta":{"content":"ok"}}]}';

/** Кадр расхода LiteLLM как есть: запись часового кэша. */
const WRITE_1H = JSON.stringify({
  id: 'c1',
  choices: [],
  usage: {
    completion_tokens: 4,
    prompt_tokens: 9728,
    total_tokens: 9732,
    prompt_tokens_details: {
      cache_write_tokens: 9712,
      cached_tokens: 0,
      text_tokens: 16,
      cache_creation_tokens: 9712,
      cache_creation_token_details: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 9712,
      },
    },
    cache_creation_input_tokens: 9712,
    cache_read_input_tokens: 0,
  },
});

/** Тот же префикс шесть минут спустя: чтение. */
const READ_1H = JSON.stringify({
  id: 'c2',
  choices: [],
  usage: {
    completion_tokens: 4,
    prompt_tokens: 9728,
    total_tokens: 9732,
    prompt_tokens_details: {
      cache_write_tokens: 0,
      cached_tokens: 9712,
      cache_creation_token_details: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 9712,
  },
});

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls: { url: string; body: string }[] = [];

function upstream(frames: string[]): PlatformFetch {
  return (url, init) => {
    calls.push({ url, body: init?.body ?? '' });
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

async function start(
  fetchImpl: PlatformFetch,
  platform: Platform = PLATFORM,
  pricing?: () => PricingLookup,
): Promise<void> {
  writePlatform(store, platform);
  writeToken(appData, platform.id, SECRET);
  await gateway.start({
    store,
    appDataDir: appData,
    port: 0,
    fetchImpl,
    spendFlushMs: 0,
    ...(pricing ? { pricing } : {}),
  });
  port = gateway.status().port;
}

async function ask(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const HOUR = { type: 'ephemeral', ttl: '1h' } as const;

/** Запрос в форме Claude Code: две части системы, последняя помечена, инструменты, ход с вызовом. */
function claudeCodeRequest(model: string, stream = true): Record<string, unknown> {
  return {
    model,
    max_tokens: 64,
    stream,
    system: [
      { type: 'text', text: 'You are Claude Code.' },
      // Чужое поле пометки (бета вендора) наверх не едет: строгая схема отвергла бы запрос.
      {
        type: 'text',
        text: 'Длинная системная строка.',
        cache_control: { ...HOUR, scope: 'global' },
      },
    ],
    tools: [
      { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
      {
        name: 'Bash',
        description: 'run a command',
        input_schema: { type: 'object' },
        cache_control: HOUR,
      },
    ],
    messages: [
      { role: 'user', content: 'прочитай файл' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abc', cache_control: HOUR }],
      },
    ],
  };
}

type Part = { type: string; text?: string; cache_control?: Record<string, unknown> };
type Message = { role: string; content: string | Part[] };

function sentMessages(): Message[] {
  const body = JSON.parse(calls[0]!.body) as { messages: Message[] };
  return body.messages;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-gateway-cache-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  gateway = new PlatformGateway();
  calls = [];
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('пометки кэша наверх (n4a)', () => {
  it('модель claude у платформы компании: пометки едут на те же части, система — на дописку прослойки', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const answer = await ask(
      '/enterprise-platform/v1/messages',
      claudeCodeRequest('claude-haiku-5-5'),
    );
    expect(answer.status).toBe(200);

    const messages = sentMessages();
    const system = messages[0]!;
    expect(system.role).toBe('system');
    // Части системы остаются частями: склеенные в строку, они потеряли бы пометку.
    expect(Array.isArray(system.content)).toBe(true);
    const parts = system.content as Part[];
    expect(parts.map((part) => part.text?.slice(0, 20))).toEqual([
      'You are Claude Code.',
      'Длинная системная ст',
      expect.any(String),
    ]);
    // Последняя пометка системы переехала на дописку прослойки (там список инструментов):
    // в кэш до неё входят и система, и инструменты. Чужое поле `scope` срезано.
    expect(parts[1]!.cache_control).toBeUndefined();
    expect(parts[2]!.cache_control).toEqual(HOUR);
    expect(parts[2]!.text).toContain('Bash');

    // Результат инструмента свёрнут прослойкой в текст — пометка на этой же части.
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe('user');
    const lastParts = last.content as Part[];
    expect(lastParts[lastParts.length - 1]!.cache_control).toEqual(HOUR);

    // Пометок наверх не больше, чем прислал клиент: у вендора их предел — четыре.
    expect(calls[0]!.body.match(/"cache_control"/g)?.length).toBe(2);
    // Перенесённое не названо потерей.
    expect(gateway.status().events[0]?.lost ?? []).not.toContain('cache_control');
  });

  it('модель gpt того же контура: пометок наверх нет ни одной, потеря названа', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const answer = await ask('/enterprise-platform/v1/messages', claudeCodeRequest('gpt-4.1-mini'));
    expect(answer.status).toBe(200);
    expect(calls[0]!.body).not.toContain('cache_control');
    // Система по-прежнему одной строкой — путь gpt не изменился.
    expect(typeof sentMessages()[0]!.content).toBe('string');
    expect(gateway.status().events[0]?.lost).toContain('cache_control');
  });

  it('совместимый шлюз без объявления: пометок нет и у модели claude', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']), {
      ...PLATFORM,
      id: 'compat',
      driver: 'openai-compat',
    });
    const answer = await ask('/compat/v1/messages', claudeCodeRequest('claude-haiku-5-5'));
    expect(answer.status).toBe(200);
    expect(calls[0]!.body).not.toContain('cache_control');
  });
});

describe('запись в кэш доезжает до клиента Anthropic (n4b)', () => {
  it('потоком: запись и её часовая разбивка — в итоговом message_delta', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const answer = await ask(
      '/enterprise-platform/v1/messages',
      claudeCodeRequest('claude-haiku-5-5'),
    );
    const tail = answer.text.slice(answer.text.indexOf('event: message_delta'));
    const delta = JSON.parse(tail.split('\n')[1]!.slice('data: '.length)) as {
      usage: Record<string, unknown>;
    };
    expect(delta.usage).toEqual({
      input_tokens: 16,
      cache_creation_input_tokens: 9712,
      output_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9712 },
    });
  });

  it('потоком: чтение того же префикса — прочитанное, без записи', async () => {
    await start(upstream([DELTA, READ_1H, '[DONE]']));
    const answer = await ask(
      '/enterprise-platform/v1/messages',
      claudeCodeRequest('claude-haiku-5-5'),
    );
    const tail = answer.text.slice(answer.text.indexOf('event: message_delta'));
    const delta = JSON.parse(tail.split('\n')[1]!.slice('data: '.length)) as {
      usage: Record<string, unknown>;
    };
    expect(delta.usage).toEqual({
      input_tokens: 16,
      cache_read_input_tokens: 9712,
      output_tokens: 4,
    });
  });

  it('без потока: те же поля в цельном теле', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const answer = await ask(
      '/enterprise-platform/v1/messages',
      claudeCodeRequest('claude-haiku-5-5', false),
    );
    const body = JSON.parse(answer.text) as { usage: Record<string, unknown> };
    expect(body.usage).toEqual({
      input_tokens: 16,
      cache_creation_input_tokens: 9712,
      output_tokens: 4,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 9712 },
    });
  });
});

/**
 * Ревью K, 🟡2: деньги хода по ставкам кэша. Haiku — вход 1, выход 5, чтение 0.1,
 * запись 1.25, часовая 2 за миллион; ход группы на контуре в основном читает кэш.
 */
const HAIKU: PricingLookup = {
  entries: [
    {
      id: 'claude-haiku-5-5',
      label: 'Claude Haiku 5.5',
      price: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
    },
  ],
};

describe('расход контура считает кэш по его ставкам (ревью K)', () => {
  it('чтение 9712 из 9728 — по ставке чтения, и полоса бюджета видит именно это', async () => {
    await start(
      upstream([DELTA, READ_1H, '[DONE]']),
      { ...PLATFORM, budgetUsd: 0.005 },
      () => HAIKU,
    );
    const answer = await ask(
      '/enterprise-platform/v1/messages',
      claudeCodeRequest('claude-haiku-5-5'),
    );
    expect(answer.status).toBe(200);

    const record = store.getPlatformSpend()['enterprise-platform']!;
    // 16 свежих + 9712 чтения + 4 выхода; по ставке входа было бы 0.009748 $ — выше бюджета.
    expect(record.days[0]!.money.usd).toBeCloseTo((16 * 1 + 9712 * 0.1 + 4 * 5) / 1e6, 6);
    const verdict = budgetVerdict({ ...PLATFORM, budgetUsd: 0.005 }, record);
    expect(verdict.overEstimate).toBe(false);
    expect(verdict.nearLimit).toBe(false);
  });

  it('часовая запись — по часовой ставке, без потока тоже', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']), PLATFORM, () => HAIKU);
    await ask('/enterprise-platform/v1/messages', claudeCodeRequest('claude-haiku-5-5', false));
    const day = store.getPlatformSpend()['enterprise-platform']!.days[0]!;
    expect(day.money.usd).toBeCloseTo((16 * 1 + 9712 * 2 + 4 * 5) / 1e6, 6);
    // Токены дня — как прислал контур: вход вместе с кэшем.
    expect(day.promptTokens).toBe(9728);
  });
});

describe('пометки кэша: предел и стабильность префикса (ревью K, ⚪7)', () => {
  it('четыре пометки клиента — наверх не больше четырёх: список инструментов сливается с системой', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const request = claudeCodeRequest('claude-haiku-5-5');
    // Как Claude Code: инструменты, система и две последние реплики пользователя.
    const messages = request.messages as Record<string, unknown>[];
    messages[0] = {
      role: 'user',
      content: [{ type: 'text', text: 'прочитай файл', cache_control: HOUR }],
    };
    expect(JSON.stringify(request).match(/"cache_control"/g)?.length).toBe(4);

    await ask('/enterprise-platform/v1/messages', request);
    expect(calls[0]!.body.match(/"cache_control"/g)?.length).toBe(3);
    expect(gateway.status().events[0]?.lost ?? []).not.toContain('cache_control');
  });

  it('без пометки у системы список инструментов занимает дописку: четыре и остаются четырьмя', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const request = claudeCodeRequest('claude-haiku-5-5');
    request.system = [{ type: 'text', text: 'You are Claude Code.' }];
    const messages = request.messages as Record<string, unknown>[];
    messages[0] = {
      role: 'user',
      content: [{ type: 'text', text: 'прочитай файл', cache_control: HOUR }],
    };
    messages.push(
      { role: 'assistant', content: 'готово' },
      { role: 'user', content: [{ type: 'text', text: 'дальше', cache_control: HOUR }] },
    );
    expect(JSON.stringify(request).match(/"cache_control"/g)?.length).toBe(4);

    await ask('/enterprise-platform/v1/messages', request);
    expect(calls[0]!.body.match(/"cache_control"/g)?.length).toBe(4);
  });

  it('с маскировкой (DLP) префикс второго хода совпадает с первым байт в байт', async () => {
    saveRules(appData, [
      {
        id: 'r1',
        name: 'Фамилии сотрудников',
        enabled: true,
        kind: 'terms',
        terms: ['Иванов', 'Петров'],
        pattern: '',
        action: 'mask',
        label: 'ИМЯ',
      },
    ]);
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    const turn = (extra: Record<string, unknown>[]): Record<string, unknown> => ({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      stream: true,
      system: [{ type: 'text', text: 'Проект ведёт Иванов.', cache_control: HOUR }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Спроси у Иванов статус' }] },
        { role: 'assistant', content: 'спросил' },
        ...extra,
      ],
    });
    await ask('/enterprise-platform/v1/messages', turn([]));
    // Второй ход несёт новое имя ПОСЛЕ прежних: номера прежних подстановок не сдвигаются.
    await ask(
      '/enterprise-platform/v1/messages',
      turn([{ role: 'user', content: [{ type: 'text', text: 'и у Петров тоже' }] }]),
    );
    const first = JSON.parse(calls[0]!.body) as { messages: unknown[] };
    const second = JSON.parse(calls[1]!.body) as { messages: unknown[] };
    expect(calls[0]!.body + calls[1]!.body).not.toMatch(/Иванов|Петров/);
    expect(JSON.stringify(second.messages.slice(0, 3))).toBe(
      JSON.stringify(first.messages.slice(0, 3)),
    );
  });
});

describe('пустые части с пометками не уходят к вендору (ревью K, ⚪8)', () => {
  it('пустой и пробельный текст выброшен, пометка такого блока — на часть перед ним', async () => {
    await start(upstream([DELTA, WRITE_1H, '[DONE]']));
    await ask('/enterprise-platform/v1/messages', {
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'вопрос' },
            { type: 'text', text: '' },
            { type: 'text', text: '  \n', cache_control: HOUR },
            { type: 'text', text: 'ещё' },
          ],
        },
      ],
    });
    expect(sentMessages().find((message) => message.role === 'user')?.content).toEqual([
      { type: 'text', text: 'вопрос', cache_control: HOUR },
      { type: 'text', text: 'ещё' },
    ]);
  });
});
