import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerContext } from '../../context.ts';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { createCoreAskPort } from '../../domains/core-ask/core-ask.ts';
import {
  startFakeCore,
  type FakeCore,
  type FakeCoreOptions,
} from '../../domains/core-ask/__fixtures__/fake-core.ts';
import type { AskCarry } from '../../domains/core-ask/core-ask.types.ts';
import { registerAssistantRoutes } from './assistant-routes.ts';

/**
 * Окно помощника формы и окно ассистента через ядро (этап 10, F2b): маршрут панели, его схема и
 * маска — настоящие, клиент ядра (`createCoreAskPort`) идёт настоящим HTTP к ядру-заглушке, которая
 * разбирает тело контрактом и отвечает сценарием хода. Своего процесса CLI у окна больше нет.
 */

let app: FastifyInstance | undefined;
let dir: string;
let store: AppStore;
let core: FakeCore | undefined;
let reply = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'assist-core-route-'));
  store = new AppStore(join(dir, 'agentdeck'));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function start(options: FakeCoreOptions = {}, carry?: AskCarry): Promise<void> {
  core = await startFakeCore({
    turn: async ({ emit }) => {
      emit({ kind: 'assistant-text', data: { text: reply } });
      emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
    },
    ...options,
  });
  app = Fastify();
  const ctx = { store, location: { paths: { appData: join(dir, 'agentdeck') } } };
  registerAssistantRoutes(
    app,
    ctx as unknown as ServerContext,
    createCoreAskPort(() => core!.home, core.identity),
    carry,
  );
}

const post = (url: string, payload: unknown) =>
  app!.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/assist через ядро', () => {
  it.each([
    ['нет просьбы', { kind: 'rule', fields: {}, schema: {} }],
    ['поля — не объект', { kind: 'rule', message: 'x', fields: 'title=x', schema: {} }],
    ['история — не список реплик', { kind: 'rule', message: 'x', fields: {}, history: 'hi' }],
  ])('кривое тело (%s) → 400 с кодом, к ядру не идёт', async (_name, payload) => {
    await start();
    const response = await post('/api/assist', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'assistant-request-invalid' });
    expect(core!.asks).toEqual([]);
  });

  it('история и маска: секрет к ядру не уходит, вопрос без инструментов, поле вернулось секретом', async () => {
    reply = JSON.stringify({
      reply: 'Добавил QA_MODE.',
      fields: { envText: 'QA_API_TOKEN=••••••\nQA_MODE=1' },
    });
    await start();
    const response = await post('/api/assist', {
      kind: 'MCP server',
      message: 'добавь QA_MODE=1',
      fields: { name: 'qa', envText: 'QA_API_TOKEN=qa-route-secret-1' },
      schema: { envText: 'Env lines. Value: a string.' },
      history: [
        { role: 'user', text: 'назови сервер qa' },
        { role: 'assistant', text: 'Назвал.' },
      ],
      sessionId: 'd3b07384-d9a0-4c9b-8a4e-0f1e2d3c4b5a',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reply: 'Добавил QA_MODE.',
      fields: { envText: 'QA_API_TOKEN=qa-route-secret-1\nQA_MODE=1' },
    });
    const [asked] = core!.asks;
    expect(asked).toMatchObject({ tools: 'none', adapter: 'claude', consumer: 'assistant' });
    expect(asked!.prompt).not.toContain('qa-route-secret-1');
    expect(asked!.prompt).toContain('Human: назови сервер qa');
    expect(asked!.prompt).toContain("The user's current request: добавь QA_MODE=1");
  });

  it('CLI без судьи ядра — отказ с кодом в ответе 200, задачи ядра нет', async () => {
    store.updateSettings({ provider: 'gemini' });
    await start();
    const response = await post('/api/assist', { kind: 'rule', message: 'x' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      fields: {},
      messageCode: 'assistant-provider-unsupported',
    });
    expect(core!.asks).toEqual([]);
  });
});

describe('POST /api/assistant/run через ядро', () => {
  it('картинки без реплики человека → 400, а не молчаливая потеря', async () => {
    await start();
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const response = await post('/api/assistant/run', {
      messages: [{ role: 'assistant', content: 'было' }],
      images: [{ name: 'a.png', mediaType: 'image/png', base64: png }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ messageCode: 'media-agent-images-invalid' });
    expect(core!.asks).toEqual([]);
  });

  it('cursor — unsupported, режим none, вызова модели нет', async () => {
    store.updateSettings({ provider: 'cursor' });
    await start();
    const response = await post('/api/assistant/run', {
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, mode: 'none', reason: 'unsupported' });
    expect(core!.asks).toEqual([]);
  });

  it('ответ ядра: секрет под маской до ядра, дословная строка в ответе — секретом', async () => {
    await start({
      turn: async ({ fields, emit }) => {
        const line = fields.prompt.split('\n').find((l) => l.startsWith('DB_PASSWORD='));
        emit({ kind: 'assistant-text', data: { text: `Вот строка:\n${line}` } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
    const response = await post('/api/assistant/run', {
      messages: [{ role: 'user', content: 'повтори\nDB_PASSWORD="hunter two 2"' }],
      conversationId: 'ignored',
    });
    expect(response.json()).toMatchObject({
      ok: true,
      mode: 'cli',
      reply: 'Вот строка:\nDB_PASSWORD="hunter two 2"',
    });
    expect(core!.asks[0]!.prompt).not.toContain('hunter two 2');
  });

  it('набор чужого CLI (G13): окно формы его везёт, /api/assistant/run — нет, как прежнее окно', async () => {
    store.updateSettings({ provider: 'qwen' });
    reply = JSON.stringify({ reply: 'ок', fields: {} });
    const asked: string[] = [];
    const carry: AskCarry = ({ cli }) => {
      asked.push(cli);
      return {
        ok: true,
        session: { env: ['QWEN_HOME'] },
        env: { QWEN_HOME: join(dir, 'kit', 'qwen-home') },
      };
    };
    await start({}, carry);
    await post('/api/assist', { kind: 'rule', message: 'назови правило', fields: {}, schema: {} });
    await post('/api/assistant/run', { messages: [{ role: 'user', content: 'привет' }] });
    expect(asked).toEqual(['qwen']);
    expect(core!.asks.map((a) => a.session)).toEqual([{ env: ['QWEN_HOME'] }, undefined]);
    expect(core!.askEnvs).toEqual([{ QWEN_HOME: join(dir, 'kit', 'qwen-home') }, undefined]);
  });

  it('отказ дороги ядра (у маршрута нет ключа) — cli_error с причиной ядра', async () => {
    store.updateSettings({ provider: 'codex' });
    await start({
      noSession: { reason: 'session road refused: compat refused: credential_absent' },
    });
    const response = await post('/api/assistant/run', {
      messages: [{ role: 'user', content: 'привет' }],
    });
    expect(response.json()).toMatchObject({ ok: false, mode: 'cli', reason: 'cli_error' });
    expect((response.json() as { error: string }).error).toContain('credential_absent');
  });
});
