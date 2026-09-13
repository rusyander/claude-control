import { describe, it, expect } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import type { Platform } from '@agentdeck/contracts';
import { embedTexts, EmbeddingError, MAX_EMBEDDING_INPUTS } from './embeddings.ts';
import type { PlatformFetch } from './ca-fetch.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Эмбеддинги контура. Проверяется ровно то, на чём молчаливая ошибка стоит
 * дорого: модель не угадывается, ответ без векторов не выдаётся за успех, а
 * ключ не просачивается в текст отказа.
 */

const BASE: Platform = {
  id: 'enterprise-platform-dev',
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
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const TOKEN = 'sk-live-0123456789abcdef';

function stub(
  body: string,
  init: { status?: number } = {},
): { fetchImpl: PlatformFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: PlatformFetch = (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

const VECTORS = JSON.stringify({
  model: 'ru-embed',
  data: [
    { index: 0, embedding: [0.1, 0.2, 0.3] },
    { index: 1, embedding: [0.4, 0.5, 0.6] },
  ],
  usage: { prompt_tokens: 8, total_tokens: 8 },
});

describe('embedTexts', () => {
  it('векторы, их длина и расход приходят как есть', async () => {
    const { fetchImpl, calls } = stub(VECTORS);
    const result = await embedTexts({
      platform: BASE,
      token: TOKEN,
      model: 'ru-embed',
      input: ['раз', 'два'],
      fetchImpl,
    });

    expect(result.vectors).toHaveLength(2);
    expect(result.dimensions).toBe(3);
    expect(result.totalTokens).toBe(8);
    expect(calls[0]?.url).toBe('https://api.dev.example.ru/v1/embeddings');
    // Поток тут не предлагается: контур на него отвечает четырёхсотым.
    expect((calls[0]?.init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('строки раскладываются по index, а не по порядку в ответе', async () => {
    // Единственное, что связывает вектор с текстом, — место в списке. Приняв
    // порядок ответа на веру, панель отдала бы вектор второго текста под
    // первым, и всякая посчитанная по ним похожесть врала бы молча.
    const { fetchImpl } = stub(
      JSON.stringify({
        model: 'ru-embed',
        data: [
          { index: 1, embedding: [0.4, 0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
      }),
    );
    const result = await embedTexts({
      platform: BASE,
      token: TOKEN,
      model: 'ru-embed',
      input: ['раз', 'два'],
      fetchImpl,
    });

    expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.vectors[1]).toEqual([0.4, 0.5, 0.6]);
  });

  it('векторов меньше, чем текстов, — отказ, а не короткий список', async () => {
    const { fetchImpl } = stub(
      JSON.stringify({ model: 'ru-embed', data: [{ index: 0, embedding: [0.1] }] }),
    );

    await expect(
      embedTexts({
        platform: BASE,
        token: TOKEN,
        model: 'ru-embed',
        input: ['раз', 'два'],
        fetchImpl,
      }),
    ).rejects.toThrow('1 векторов на 2 текстов');
  });

  it('без модели не ходит по сети вовсе: угадывать её по имени нельзя', async () => {
    let called = false;
    const fetchImpl: PlatformFetch = () => {
      called = true;
      return Promise.resolve(new Response(VECTORS));
    };

    await expect(
      embedTexts({ platform: BASE, token: TOKEN, model: '  ', input: ['раз'], fetchImpl }),
    ).rejects.toBeInstanceOf(EmbeddingError);
    expect(called).toBe(false);
  });

  it('слишком длинный список отвергается с числом, а не молча режется', async () => {
    const { fetchImpl } = stub(VECTORS);
    const input = Array.from({ length: MAX_EMBEDDING_INPUTS + 1 }, (_, i) => String(i));

    await expect(
      embedTexts({ platform: BASE, token: TOKEN, model: 'ru-embed', input, fetchImpl }),
    ).rejects.toThrow(String(MAX_EMBEDDING_INPUTS + 1));
  });

  it('ответ без векторов — отказ, а не пустой успех', async () => {
    const { fetchImpl } = stub(JSON.stringify({ model: 'ru-embed', data: [] }));

    await expect(
      embedTexts({ platform: BASE, token: TOKEN, model: 'ru-embed', input: ['раз'], fetchImpl }),
    ).rejects.toThrow('ни одного вектора');
  });

  it('ключ, отражённый контуром в тексте ошибки, наружу не уходит', async () => {
    const { fetchImpl } = stub(`unknown api key ${TOKEN}`, { status: 400 });

    await expect(
      embedTexts({ platform: BASE, token: TOKEN, model: 'ru-embed', input: ['раз'], fetchImpl }),
    ).rejects.toThrow(/^(?!.*sk-live).*$/s);
  });

  it('отклонённый ключ отвечает своим кодом, а не общим 502', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

    await expect(
      embedTexts({ platform: BASE, token: TOKEN, model: 'ru-embed', input: ['раз'], fetchImpl }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
