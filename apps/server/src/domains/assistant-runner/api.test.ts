import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeProvider } from '../../providers/claude.ts';
import { getProvider, listProviders } from '../../providers/registry.ts';
import type { ConfigProvider, ProviderAssistant } from '../../providers/types/types.ts';
import { serverText } from '../../lib/server-texts/server-texts.ts';
import { API_MAX_OUTPUT_TOKENS, runProviderApi } from './api.ts';

/**
 * Прямой вызов модельного API: куда уходит ключ (06.10, SF-1/D1). Сеть — внешняя
 * граница, поэтому подменён только `fetch`: всё, что решает адрес и отказ, —
 * настоящий код. Ключ — метка, по ней видно, ушёл ли он куда-нибудь.
 */
const KEY = 'qa-vendor-key-DO-NOT-LEAK-7731';
const TRAP = 'http://127.0.0.1:9/trap/v1';

function okFetch(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const chatReply = { choices: [{ message: { content: 'ответ вендора' } }] };
const ask = [{ role: 'user' as const, content: 'привет' }];

function withAssistant(
  provider: ConfigProvider,
  patch: Partial<ProviderAssistant>,
): ConfigProvider {
  return { ...provider, assistant: { ...provider.assistant!, ...patch } };
}

describe('runProviderApi: ключ уходит только своему вендору', () => {
  let dir: string;
  let savedBase: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-api-vendor-'));
    savedBase = process.env.OPENAI_BASE_URL;
    // Ловушка: переменная, заведённая человеком для ДРУГОГО инструмента.
    process.env.OPENAI_BASE_URL = TRAP;
  });
  afterEach(() => {
    if (savedBase === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBase;
    rmSync(dir, { recursive: true, force: true });
  });

  it('openai-compat без адреса вендора (kimi) — отказ кодом, запроса нет', async () => {
    const kimi = withAssistant(getProvider('kimi'), { apiBaseUrl: undefined });
    const fetchMock = okFetch(chatReply);
    const res = await runProviderApi(kimi, ask, KEY, { appDataDir: dir, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ok: false,
      mode: 'none',
      reason: 'unsupported',
      messageCode: 'assistant-api-base-unknown',
      params: { provider: kimi.name },
      error: serverText('assistant-api-base-unknown', { provider: kimi.name }),
    });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  it('anthropic у чужого CLI (continue) — отказ, до Anthropic запрос не идёт', async () => {
    const cont = withAssistant(getProvider('continue'), { apiKind: 'anthropic' });
    const fetchMock = okFetch({ content: [{ type: 'text', text: 'это Claude' }] });
    const res = await runProviderApi(cont, ask, KEY, { appDataDir: dir, fetchImpl: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, messageCode: 'assistant-api-base-unknown' });
  });

  it('каталог: ни один провайдер без своего адреса не отправляет ключ', async () => {
    for (const provider of listProviders()) {
      const kind = provider.assistant?.apiKind;
      const blind =
        (kind === 'anthropic' && provider.id !== 'claude') ||
        (kind === 'openai-compat' && !provider.assistant?.apiBaseUrl);
      if (!blind) continue;
      const fetchMock = okFetch(chatReply);
      const res = await runProviderApi(provider, ask, KEY, {
        appDataDir: dir,
        fetchImpl: fetchMock,
      });
      expect(fetchMock, provider.id).not.toHaveBeenCalled();
      expect(res.ok, provider.id).toBe(false);
    }
  });

  it('openai-compat с адресом вендора — туда, OPENAI_BASE_URL не читается', async () => {
    const vendor = withAssistant(getProvider('kimi'), {
      apiBaseUrl: 'https://vendor.example.com/v1/',
    });
    const fetchMock = okFetch(chatReply);
    const res = await runProviderApi(vendor, ask, KEY, { appDataDir: dir, fetchImpl: fetchMock });
    expect(res).toMatchObject({ ok: true, mode: 'api', reply: 'ответ вендора' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://vendor.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith(TRAP))).toBe(false);
  });

  it('свои облака не тронуты: claude → Anthropic, codex → OpenAI мимо OPENAI_BASE_URL', async () => {
    const anthropic = okFetch({ content: [{ type: 'text', text: 'claude' }] });
    const claude = await runProviderApi(claudeProvider, ask, KEY, {
      appDataDir: dir,
      fetchImpl: anthropic,
    });
    expect(claude.ok).toBe(true);
    expect(anthropic.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages');

    const openai = okFetch(chatReply);
    const codex = await runProviderApi(getProvider('codex'), ask, KEY, {
      appDataDir: dir,
      fetchImpl: openai,
    });
    expect(codex.ok).toBe(true);
    expect(openai.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('свой эндпоинт правилом не судится: адрес выбрал человек', async () => {
    const cont = withAssistant(getProvider('continue'), { apiKind: 'anthropic' });
    const fetchMock = okFetch({ content: [{ type: 'text', text: 'с эндпоинта' }] });
    const res = await runProviderApi(cont, ask, '', {
      appDataDir: dir,
      fetchImpl: fetchMock,
      endpoint: { baseUrl: 'http://127.0.0.1:8080', apiKind: 'anthropic', model: 'local' },
    });
    expect(res).toMatchObject({ ok: true, reply: 'с эндпоинта' });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8080/v1/messages');
  });
});

/**
 * Предел длины ответа (10.10): обрезок не выдаётся за ответ. Помощник структуры
 * разбирает ответ как JSON и пишет файлы — оборванный ответ записал бы половину
 * файла, поэтому каждый вид API распознаёт свой признак обрыва и отказывает кодом.
 */
describe('runProviderApi: ответ, оборванный на пределе длины', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-api-limit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const half = '{"reply": "Собрал навык", "files": [{"path": "SKILL.md", "content": "---\nna';
  const truncatedRefusal = {
    ok: false,
    mode: 'api',
    messageCode: 'assistant-reply-truncated',
    error: serverText('assistant-reply-truncated'),
  };

  it('anthropic: потолок вмещает многофайловый навык, stop_reason max_tokens — отказ', async () => {
    const fetchMock = okFetch({
      content: [{ type: 'text', text: half }],
      stop_reason: 'max_tokens',
    });
    const res = await runProviderApi(claudeProvider, ask, KEY, {
      appDataDir: dir,
      fetchImpl: fetchMock,
    });
    expect(res).toMatchObject(truncatedRefusal);
    expect(res.reply).toBe('');
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { max_tokens: number };
    // 20 КБ русского текста при ~2 символах на токен — 10 000 токенов.
    expect(body.max_tokens).toBe(API_MAX_OUTPUT_TOKENS);
    expect(body.max_tokens).toBeGreaterThanOrEqual(10_000);
  });

  it('anthropic: end_turn — ответ как есть', async () => {
    const fetchMock = okFetch({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' });
    const res = await runProviderApi(claudeProvider, ask, KEY, {
      appDataDir: dir,
      fetchImpl: fetchMock,
    });
    expect(res).toMatchObject({ ok: true, reply: '{}' });
  });

  it('openai: finish_reason length — отказ', async () => {
    const fetchMock = okFetch({
      choices: [{ message: { content: half }, finish_reason: 'length' }],
    });
    const res = await runProviderApi(getProvider('codex'), ask, KEY, {
      appDataDir: dir,
      fetchImpl: fetchMock,
    });
    expect(res).toMatchObject(truncatedRefusal);
  });

  it('google: finishReason MAX_TOKENS — отказ', async () => {
    const fetchMock = okFetch({
      candidates: [{ content: { parts: [{ text: half }] }, finishReason: 'MAX_TOKENS' }],
    });
    const res = await runProviderApi(getProvider('continue'), ask, '', {
      appDataDir: dir,
      fetchImpl: fetchMock,
      endpoint: { baseUrl: 'http://127.0.0.1:8080', apiKind: 'google', model: 'local' },
    });
    expect(res).toMatchObject(truncatedRefusal);
  });
});
