import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform } from '@agentdeck/contracts';
import { AppStore } from '../../../lib/app-store.ts';
import { writePlatform, writeToken } from '../store.ts';
import type { PlatformFetch } from '../ca-fetch.ts';
import { PlatformGateway } from './listener.ts';

/**
 * L9 через шлюз целиком: настоящий слушатель, настоящий HTTP, подставлен только
 * контур. Первый ответ модели с голым `</think>` ещё уходит как есть — угадывать
 * это заранее у каждой модели значило бы держать каждый ответ, — но факт
 * записывается в хранилище, и второй ответ той же модели клиент получает уже
 * без размышления. Факт переживает перезапуск шлюза: он в `state.json`.
 */

const PLATFORM: Platform = {
  id: 'dev',
  title: 'ТЕСТ · dev',
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

const MODEL = 'Qwen/Qwen3.8-27B-FP8';

const chunk = (content: string, finish: string | null = null): string =>
  JSON.stringify({
    id: 'c1',
    model: MODEL,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });

/** Живая форма ответа dev: размышление текстом, голый тег, разрезанный чанками. */
const QWEN_FRAMES = [
  chunk('Пользователь здоровается.'),
  chunk(' Отвечу коротко.\n</th'),
  chunk('ink>\n\n'),
  chunk('Привет!', 'stop'),
  '[DONE]',
];

function qwen(): PlatformFetch {
  return () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const frame of QWEN_FRAMES) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
}

let root: string;
let appData: string;
let store: AppStore;
let gateway: PlatformGateway;

async function start(): Promise<number> {
  await gateway.start({ store, appDataDir: appData, port: 0, fetchImpl: qwen(), spendFlushMs: 0 });
  return gateway.status().port;
}

/** Текст, который получил клиент диалекта OpenAI, — подряд из всех чанков. */
async function askText(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/dev/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: 'привет' }],
    }),
  });
  expect(response.status).toBe(200);
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => {
      const payload = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string } }[];
      };
      return payload.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-think-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);
  writePlatform(store, PLATFORM);
  writeToken(appData, PLATFORM.id, 'platform-token-think');
  gateway = new PlatformGateway();
});

afterEach(async () => {
  await gateway.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('размышления текстом через шлюз', () => {
  it('первый ответ учит шлюз, второй приходит клиенту без размышления', async () => {
    const port = await start();

    const first = await askText(port);
    expect(first).toContain('</think>');
    expect(store.getThinkTailModels(PLATFORM.id)).toEqual([MODEL]);

    const second = await askText(port);
    expect(second).toBe('Привет!');
    expect(gateway.status().events[0]?.stages).toContain('reasoning');
  });

  it('факт переживает перезапуск панели и уходит вместе с контуром', async () => {
    let port = await start();
    await askText(port);
    await gateway.stop();

    store = new AppStore(appData);
    gateway = new PlatformGateway();
    port = await start();
    expect(await askText(port)).toBe('Привет!');

    store.forgetPlatformHealth(PLATFORM.id);
    expect(store.getThinkTailModels(PLATFORM.id)).toEqual([]);
  });

  it('модель, не пойманная на голом теге, ничего не держит', async () => {
    const port = await start();
    store.markThinkTail(PLATFORM.id, 'другая-модель');
    const text = await askText(port);
    expect(text).toContain('Пользователь здоровается.');
    expect(store.getThinkTailModels(PLATFORM.id)).toEqual(['другая-модель', MODEL]);
  });
});
