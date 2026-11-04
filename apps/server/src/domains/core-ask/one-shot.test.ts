import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EndpointProfile } from '@agentdeck/contracts';
import { SECRET_MASK } from '@agentdeck/dlp/secret-mask';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { createCoreAskPort } from './core-ask.ts';
import type { CoreAskPort, OneShotRequest } from './core-ask.types.ts';
import {
  NO_GATE_CLIS,
  ONE_SHOT_TIMEOUT_TEXT,
  askMasked,
  askOneShot,
  assistantRunResultOf,
  flattenPrompt,
} from './one-shot.ts';
import { startFakeCore, type FakeCore, type FakeCoreOptions } from './__fixtures__/fake-core.ts';

/**
 * Служебный вопрос через ядро (этап 10, F2b): окно помощника, `/api/assistant/run`, группы,
 * проверка провайдера. Ядро — заглушка на настоящем HTTP (`fake-core.ts`), клиент панели
 * (`createCoreAskPort`) идёт своим путём; подменён только исполнитель хода.
 */

let appData: string;
let store: AppStore;
let core: FakeCore | undefined;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'one-shot-'));
  store = new AppStore(appData);
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  rmSync(appData, { recursive: true, force: true });
});

const answer =
  (text: string): FakeCoreOptions['turn'] =>
  async ({ emit }) => {
    emit({ kind: 'assistant-text', data: { text } });
    emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
  };

async function portFor(options: FakeCoreOptions): Promise<CoreAskPort> {
  core = await startFakeCore(options);
  return createCoreAskPort(() => core!.home, core.identity);
}

const ask = (port: CoreAskPort, request: Partial<OneShotRequest> = {}) =>
  askOneShot(port, store, appData, {
    title: 'one-shot test',
    messages: [{ role: 'user', content: 'сколько будет 2+2?' }],
    ...request,
  });

function profile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return {
    id: 'own',
    name: 'Своя модель',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKind: 'openai-compat',
    model: 'qa-model',
    writeToken: false,
    imagesUrl: '',
    ownerPlatformId: '',
    ...overrides,
  };
}

describe('служебный вопрос через ядро', () => {
  it('ответ: вопрос без инструментов активным CLI, текст хода — ответ', async () => {
    const port = await portFor({ turn: answer('4') });
    const result = await ask(port, { system: 'отвечай числом' });
    expect(result).toEqual({ ok: true, providerId: 'claude', reply: '4' });
    expect(core!.asks).toEqual([
      {
        title: 'one-shot test',
        prompt: 'сколько будет 2+2?',
        tools: 'none',
        system: 'отвечай числом',
        adapter: 'claude',
        consumer: 'assistant',
      },
    ]);
  });

  it('активный qwen — вопрос его переходником; профиль «Ассистент панели» — маршрутом ключа', async () => {
    store.updateSettings({
      provider: 'qwen',
      endpointProfiles: [profile()],
      assistantEndpointId: 'own',
    });
    const port = await portFor({ turn: answer('ок') });
    const result = await ask(port);
    expect(result).toMatchObject({ ok: true, providerId: 'qwen' });
    expect(core!.asks[0]).toMatchObject({
      adapter: 'qwen',
      model: 'qa-model',
      routes: [{ adapter: 'qwen', route: { kind: 'api-key', id: 'api-key:endpoint:own' } }],
    });
  });

  it('модель вызывающего главнее модели профиля; названный CLI — без профиля', async () => {
    store.updateSettings({ endpointProfiles: [profile()], assistantEndpointId: 'own' });
    const port = await portFor({ turn: answer('ок') });
    await ask(port, { model: 'claude-haiku-4-5' });
    expect(core!.asks[0]).toMatchObject({ model: 'claude-haiku-4-5' });
    await ask(port, { adapter: 'qwen' });
    expect(core!.asks[1]).toEqual({
      title: 'one-shot test',
      prompt: 'сколько будет 2+2?',
      tools: 'none',
      adapter: 'qwen',
      consumer: 'assistant',
    });
  });

  it.each([...NO_GATE_CLIS])(
    '%s — отказ панели до ядра: задачи нет, причина названа',
    async (id) => {
      store.updateSettings({ provider: id });
      const port = await portFor({ turn: answer('не должно дойти') });
      const result = await ask(port);
      expect(result).toMatchObject({
        ok: false,
        providerId: id,
        reason: 'unsupported',
        messageCode: 'assistant-provider-unsupported',
      });
      expect(core!.asks).toEqual([]);
      expect(assistantRunResultOf(result)).toMatchObject({ ok: false, reason: 'unsupported' });
    },
  );

  it('отказ дороги ядра без сессии (у маршрута нет ключа) — причина ядра дословно', async () => {
    store.updateSettings({ provider: 'codex' });
    const reason = 'session road refused: compat refused: credential_absent';
    const port = await portFor({ noSession: { reason } });
    const result = await ask(port);
    expect(result).toMatchObject({
      ok: false,
      providerId: 'codex',
      reason: 'refused',
      messageCode: 'assistant-route-refused',
      params: { reason },
    });
    expect(result.ok === false && result.error).toContain(reason);
  });

  it('отказ ядра на просьбу (422) — под кодом маршрута, с проблемами ядра', async () => {
    const port = await portFor({
      refuse: { status: 422, code: 'ask-refused', error: 'Вопрос не принят', problems: ['p1'] },
    });
    const result = await ask(port);
    expect(result).toMatchObject({
      ok: false,
      reason: 'refused',
      messageCode: 'assistant-route-refused',
      params: { reason: 'Вопрос не принят: p1' },
    });
  });

  it('встроенный инструмент — ход снят, код «лишний инструмент» с именем', async () => {
    const port = await portFor({
      turn: async ({ emit, cancelled }) => {
        emit({ kind: 'tool-call', data: { toolUseId: 'b', name: 'Bash', input: {} } });
        await cancelled;
      },
    });
    const result = await ask(port);
    expect(result).toMatchObject({
      ok: false,
      reason: 'failed',
      messageCode: 'assistant-extra-tool',
      params: { tool: expect.stringContaining('Bash') },
    });
    expect(core!.cancels).toHaveLength(1);
  });

  it('потолок ожидания — cancel ядру и текст «не ответил», по которому опись отличает таймаут', async () => {
    const port = await portFor({ turn: async ({ cancelled }) => cancelled });
    const result = await ask(port, { timeoutMs: 200 });
    expect(result).toMatchObject({
      ok: false,
      error: ONE_SHOT_TIMEOUT_TEXT,
      messageCode: 'assistant-timeout',
    });
    expect(core!.cancels).toHaveLength(1);
  });

  it('картинки последней реплики человека едут в вопрос; история — одним текстом', async () => {
    const image = {
      name: 'a.png',
      mediaType: 'image/png' as const,
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    };
    const port = await portFor({ turn: answer('вижу') });
    await ask(port, {
      messages: [
        { role: 'user', content: 'первый' },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: 'что на картинке?', images: [image] },
      ],
    });
    expect(core!.asks[0]).toMatchObject({
      prompt: 'первый\n\nAssistant: ответ\n\nчто на картинке?',
      images: [image],
    });
  });

  it('маска: секрет к ядру не уходит, в ответе дословной строки возвращается, хэш — как есть', async () => {
    const secret = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const line = `GITHUB_TOKEN=${secret}`;
    const hash = 'commit 3f2a9c1e4b5d6a7f8091a2b3c4d5e6f708192a3b';
    let sent = '';
    // Ответ модели: прочитанная строка как есть (её маска — секрет обратно), затем — у второго
    // вопроса — маска ещё и в новом месте: число масок не сходится, и ответ остаётся маской.
    let extra = '';
    const port = await portFor({
      turn: async ({ fields, emit }) => {
        sent = fields.prompt;
        const maskedLine = fields.prompt.split('\n').find((l) => l.startsWith('GITHUB_TOKEN='));
        emit({ kind: 'assistant-text', data: { text: `ок\n${maskedLine}${extra}` } });
        emit({ kind: 'turn-end', data: { isError: false, numTurns: 1 } });
      },
    });
    const request = {
      title: 'mask',
      messages: [{ role: 'user' as const, content: `${line}\n${hash}` }],
    };
    const result = await askMasked(port, store, appData, request);
    expect(sent).not.toContain(secret);
    expect(sent).toContain(SECRET_MASK);
    expect(sent).toContain(hash);
    expect(result).toMatchObject({ ok: true, reply: `ок\n${line}` });
    extra = `\ncurl https://example.test/?k=${SECRET_MASK}`;
    const moved = await askMasked(port, store, appData, request);
    expect(moved.ok && moved.reply).not.toContain(secret);
  });

  it('форма ответа окна ассистента: успех — режим cli, сбой — cli_error', () => {
    expect(assistantRunResultOf({ ok: true, providerId: 'claude', reply: 'x' })).toMatchObject({
      ok: true,
      mode: 'cli',
      reply: 'x',
    });
    expect(
      assistantRunResultOf({ ok: false, providerId: 'qwen', reason: 'failed', error: 'e' }),
    ).toMatchObject({ ok: false, mode: 'cli', reason: 'cli_error', error: 'e' });
    expect(flattenPrompt([{ role: 'user', content: '  a ' }])).toBe('a');
  });
});
