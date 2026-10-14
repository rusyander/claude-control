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
import { PlatformGateway } from '../listener/listener.ts';
import type { LocalUpstreamInfo } from '../local-window/local-window.ts';

/**
 * Qwen Code, Codex и Gemini ходят к локальной модели диалектом OpenAI — через мост
 * `/v1/chat/completions`, а не родную ручку Anthropic (L4b, пункт 3). Тот же слой окна, что у
 * Claude Code, обязан стоять и здесь: отказ «не влезает», усечение `max_tokens`, срок первого
 * байта, подъём упавшего сервера. Настоящий путь: слушатель и HTTP «CLI»; подменён только ответ
 * сервера моделей. Коды ответов выбраны под повтор у Qwen Code: 503 он повторяет до десяти раз
 * (бандл 0.25.0, `RATE_LIMIT_ERROR_CODES`), 529 не знает.
 */

const PLATFORM: Platform = {
  id: 'local-bridge-test',
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

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;
let port = 0;
let sent: Array<Record<string, unknown>> = [];

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

const completion = (): Response =>
  json(200, {
    id: 'c1',
    object: 'chat.completion',
    model: 'qwen-local',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'готово' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 3, total_tokens: 43 },
  });

/** Ответ сервера моделей; каждый вызов чата попадает в `sent` телом. */
function upstream(answer: () => Response | Promise<Response>): PlatformFetch {
  return (_url, init) => {
    sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return Promise.resolve(answer());
  };
}

async function start(fetchImpl: PlatformFetch, local: Partial<LocalUpstreamInfo> | false = {}) {
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

function ask(text: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${PLATFORM.id}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen-local',
      messages: [{ role: 'user', content: text }],
      ...extra,
    }),
  });
}

interface ErrorBody {
  error: { message: string; type: string; code?: string };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-bridge-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'local-token');
  gateway = new PlatformGateway();
  sent = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('мост OpenAI: окно локальной модели', () => {
  it('запрос, не влезающий в окно, отказывается ДО сервера текстом, который Qwen Code узнаёт', async () => {
    await start(upstream(completion));
    const answer = await ask('я'.repeat(CONTEXT * 4));
    const body = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    // Те же регулярки, что у Qwen Code 0.25.0 (`CONTEXT_LENGTH_PATTERNS`): по ним он отличает переполнение.
    expect(body.error.message).toMatch(/\bprompt\s+(?:is\s+)?too long\b/i);
    expect(body.error.message).toMatch(/\btokens?\s*>\s*[\d,]+\s*(?:maximum|max|limit)\b/i);
    expect(sent).toHaveLength(0);
  });

  it('не локальный контур: тот же запрос уходит наверх как есть', async () => {
    await start(upstream(completion), false);
    const answer = await ask('я'.repeat(CONTEXT * 4));
    expect(answer.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('400 «не влезает» от самого сервера → тот же текст с числами окна', async () => {
    await start(
      upstream(() =>
        json(400, {
          error: {
            type: 'exceed_context_size_error',
            message: 'request (9001 tokens) exceeds the available context size (8192 tokens)',
            n_prompt_tokens: 9001,
            n_ctx: 8192,
          },
        }),
      ),
    );
    const answer = await ask('привет');
    const body = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(400);
    expect(body.error.message).toMatch(/prompt is too long: 9001 tokens > 4096 maximum/);
  });

  it('вход влезает, а max_tokens — нет: ответ урезается до остатка окна, запрос идёт', async () => {
    await start(upstream(completion));
    const answer = await ask('привет', { max_tokens: 32_000 });
    expect(answer.status).toBe(200);
    const asked = Number(sent[0]?.max_tokens);
    expect(asked).toBeLessThan(CONTEXT);
    expect(asked).toBeGreaterThanOrEqual(1_024);
  });

  it('max_completion_tokens урезается так же; влезающее значение не трогается', async () => {
    await start(upstream(completion));
    await ask('привет', { max_completion_tokens: 50_000 });
    expect(Number(sent[0]?.max_completion_tokens)).toBeLessThan(CONTEXT);
    await ask('привет', { max_tokens: 100 });
    expect(sent[1]?.max_tokens).toBe(100);
  });

  it('разговор передаётся серверу для сброса слота до запроса', async () => {
    const seen: Array<string | undefined> = [];
    await start(upstream(completion), {
      prepare: (session) => {
        seen.push(session);
        return Promise.resolve();
      },
    });
    await ask('привет');
    expect(seen).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe('мост OpenAI: сервер моделей упал', () => {
  it('соединение отказано → сервер поднят → запрос идёт второй раз и отвечает 200', async () => {
    let calls = 0;
    let revived = 0;
    await start(
      (_url, init) => {
        calls += 1;
        sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return calls === 1 ? Promise.reject(refused()) : Promise.resolve(completion());
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
    expect(revived).toBe(1);
    expect(calls).toBe(2);
  });

  it('подъём не удался → 503 overloaded_error (Qwen Code повторяет его до десяти раз), а не 502', async () => {
    await start(() => Promise.reject(refused()), {
      revive: () => Promise.resolve('failed'),
      notice: () => 'CUDA out of memory',
    });
    const answer = await ask('привет');
    const body = (await answer.json()) as ErrorBody;
    expect(answer.status).toBe(503);
    expect(body.error.code).toBe('overloaded_error');
    expect(body.error.message).toContain('CUDA out of memory');
  });

  it('сервер остановлен человеком (записи нет) → 503 с названной причиной', async () => {
    await start(() => Promise.reject(refused()), { revive: () => Promise.resolve('none') });
    const answer = await ask('привет');
    expect(answer.status).toBe(503);
  });

  it('не локальный контур: отказ соединения — прежний 502, воскрешения нет', async () => {
    await start(() => Promise.reject(refused()), false);
    expect((await ask('привет')).status).toBe(502);
  });

  it('загружающийся сервер отвечает 503 → клиент получает тот же 503, а не 529', async () => {
    await start(upstream(() => json(503, { error: { message: 'Loading model' } })));
    expect((await ask('привет')).status).toBe(503);
  });

  it('поток оборвался посреди ответа → подъём сервера, пока клиент повторяет', async () => {
    let revived = 0;
    const frames = [
      `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'qwen-local', choices: [{ index: 0, delta: { role: 'assistant', content: 'от' } }] })}\n\n`,
    ];
    await start(
      () => {
        const queue = [...frames];
        const encoder = new TextEncoder();
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const frame = queue.shift();
                if (frame !== undefined) controller.enqueue(encoder.encode(frame));
                else controller.error(new Error('socket hang up'));
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      },
      {
        revive: () => {
          revived += 1;
          return Promise.resolve('restarted');
        },
      },
    );
    await (await ask('привет', { stream: true })).text();
    expect(revived).toBeGreaterThanOrEqual(1);
  });
});
