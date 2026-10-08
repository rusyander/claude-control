import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../../lib/app-store/app-store.ts';
import { saveRules } from '../../../dlp/rules-store.ts';
import { writePlatform, writeToken } from '../../store/store.ts';
import type { PlatformFetch } from '../../ca-fetch/ca-fetch.ts';
import { PlatformGateway } from '../listener/listener.ts';

/**
 * Ручка `/v1/responses` (MAP D) целиком: настоящий слушатель, настоящий HTTP от
 * «Codex», подставленный контур. Подставлен только сокет наверх — перевод на
 * краю, конвейер chat/completions (ключ, маска, прослойка, след) и обратный
 * перевод в события Responses работают по-настоящему.
 */

const SECRET = 'platform-token-5e1a7c3b9d2f0';

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

const delta = (text: string): string =>
  JSON.stringify({ id: 'c1', model: 'gpt-x', choices: [{ index: 0, delta: { content: text } }] });
const STOP = JSON.stringify({
  id: 'c1',
  model: 'gpt-x',
  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
});
const USAGE =
  '{"id":"c1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}';
const CALL_TEXT =
  'Запишу. <tool_call>{"name": "Write", "arguments": {"file_path": "a.ts", "content": "x"}}</tool_call>';

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let calls: { url: string; headers: Record<string, string>; body: string }[] = [];

function upstream(frames: string[], status = 200, fail = false): PlatformFetch {
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
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
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

async function start(fetchImpl: PlatformFetch): Promise<void> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl, spendFlushMs: 0 });
  port = gateway.status().port;
}

async function ask(body: unknown): Promise<{ status: number; text: string; type: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer codex-local' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    type: response.headers.get('content-type') ?? '',
  };
}

/** События Responses из SSE: имя и тело каждого. */
function events(text: string): { type: string; data: Record<string, unknown> }[] {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data:')))
    .filter((line): line is string => Boolean(line))
    .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
    .map((data) => ({ type: String(data.type), data }));
}

/** Запрос в том виде, в каком его шлёт codex: инструкции, история, поток, `store: false`. */
const CODEX_ASK = {
  model: 'gpt-x',
  instructions: 'Ты агент.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'привет' }] }],
  stream: true,
  store: false,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-gateway-responses-'));
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

describe('шлюз: ручка /v1/responses', () => {
  it('поток: наверх — chat/completions с ключом контура, Codex — события Responses и расход', async () => {
    await start(upstream([delta('да'), STOP, USAGE, '[DONE]']));
    const answer = await ask(CODEX_ASK);

    expect(answer.status).toBe(200);
    expect(answer.type).toContain('text/event-stream');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.dev.example.ru/v1/chat/completions');
    // Ключ человека наверх не уходит — его заменяет ключ контура.
    expect(JSON.stringify(calls[0]?.headers)).toContain(SECRET);
    expect(JSON.stringify(calls[0]?.headers)).not.toContain('codex-local');
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      messages: { role: string; content: unknown }[];
      stream: boolean;
    };
    expect(sent.stream).toBe(true);
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'привет' });
    expect(sent.messages.some((m) => String(m.content).includes('Ты агент.'))).toBe(true);
    expect(sent).not.toHaveProperty('input');

    const got = events(answer.text);
    expect(got[0]?.type).toBe('response.created');
    const text = got
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.data.delta)
      .join('');
    expect(text).toBe('да');
    const done = got.at(-1);
    expect(done?.type).toBe('response.completed');
    expect((done?.data.response as { usage?: unknown }).usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    });
    // Вывод chat/completions до Codex не доезжает ни кадром.
    expect(answer.text).not.toContain('chat.completion');
    expect(answer.text).not.toContain('[DONE]');

    const event = gateway.status().events[0];
    expect(event).toMatchObject({
      path: '/enterprise-platform/v1/responses',
      status: 200,
      totalTokens: 12,
    });
  });

  it('прослойка инструментов: вызов из текста контура приходит Codex элементом function_call', async () => {
    await start(upstream([delta(CALL_TEXT), STOP, USAGE, '[DONE]']));
    const answer = await ask({
      ...CODEX_ASK,
      tools: [
        { type: 'function', name: 'Write', parameters: { type: 'object' } },
        { type: 'web_search' },
      ],
    });

    expect(answer.status).toBe(200);
    const added = events(answer.text)
      .filter((event) => event.type === 'response.output_item.done')
      .map((event) => event.data.item as { type: string; name?: string; arguments?: string });
    const call = added.find((item) => item.type === 'function_call');
    expect(call?.name).toBe('Write');
    expect(JSON.parse(call?.arguments ?? '{}')).toEqual({ file_path: 'a.ts', content: 'x' });
    expect(answer.text).not.toContain('<tool_call>');
    // Инструмент не-функция честно выпал — и это видно в следе, а не молча.
    expect(gateway.status().events[0]?.lost).toContain('tool:web_search');
  });

  it('маска данных: фамилия наверх меткой, Codex видит свой текст', async () => {
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
    await start(upstream([delta('нашёл [ИМЯ_1.1]'), STOP, '[DONE]']));
    const answer = await ask({
      ...CODEX_ASK,
      input: [{ type: 'message', role: 'user', content: 'кто такой Иванов' }],
    });

    expect(calls[0]?.body).not.toContain('Иванов');
    expect(calls[0]?.body).toContain('[ИМЯ_1.1]');
    const text = events(answer.text)
      .filter((event) => event.type === 'response.output_text.delta')
      .map((event) => event.data.delta)
      .join('');
    expect(text).toBe('нашёл Иванов');
  });

  it('отказы перевода — 400 в форме OpenAI, наверх не уходит ничего', async () => {
    await start(upstream([delta('да'), '[DONE]']));
    const cases = [
      { body: { ...CODEX_ASK, previous_response_id: 'resp_1' }, text: 'previous_response_id' },
      { body: { model: 'gpt-x' }, text: 'Responses' },
      { body: '{не json', text: 'JSON' },
    ];
    for (const { body, text } of cases) {
      const answer = await ask(body);
      expect(answer.status, text).toBe(400);
      const parsed = JSON.parse(answer.text) as { error: { message: string; type: string } };
      expect(parsed.error.type, text).toBe('invalid_request_error');
      expect(parsed.error.message, text).toContain(text);
    }
    expect(calls).toHaveLength(0);
  });

  it('отказ контура доходит до Codex статусом и телом ошибки, а не пустым потоком', async () => {
    await start(upstream(['{"error":{"message":"invalid API key"}}'], 401));
    const answer = await ask(CODEX_ASK);
    expect(answer.status).toBe(401);
    expect(answer.text).toContain('"error"');
    expect(answer.text).not.toContain('response.created');
  });

  it('обрыв контура посреди потока — response.failed, а не completed', async () => {
    await start(upstream([delta('нача')], 200, true));
    const answer = await ask(CODEX_ASK);
    const got = events(answer.text);
    expect(got.some((event) => event.type === 'response.completed')).toBe(false);
    expect(got.at(-1)?.type).toBe('response.failed');
  });

  it('неизвестный маршрут называет и /v1/responses', async () => {
    await start(upstream([]));
    const response = await fetch(`http://127.0.0.1:${port}/enterprise-platform/v1/embeddings`, {
      method: 'POST',
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('/v1/responses');
  });
});
