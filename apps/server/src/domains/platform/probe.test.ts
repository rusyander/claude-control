import { describe, it, expect } from 'vitest';
import type { Platform } from '@agentdeck/contracts';
import { probePlatform } from './probe.ts';
import type { PlatformFetch } from './ca-fetch.ts';

/**
 * Проба контура: ПЯТЬ исходов, а не два.
 *
 * Каждый случай здесь — настоящая ошибка настройки, которую человек делает
 * руками: дал адрес админки, дал протухший ключ, постучался в контур, который
 * ещё поднимается. Сливать их в «не отвечает» значит отправлять человека чинить
 * не то. Поэтому проверяется не только `outcome`, но и то, что причина названа
 * словами.
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
  agents: [],
  budgetSince: '',
  caCertPath: '',
};

/** Ответ-заглушка: тело, код и тип содержимого — всё, что читает проба. */
function reply(
  body: string,
  init: { status?: number; contentType?: string } = {},
): () => Promise<Response> {
  return () =>
    Promise.resolve(
      new Response(body, {
        status: init.status ?? 200,
        headers: { 'content-type': init.contentType ?? 'application/json' },
      }),
    );
}

const MODELS = JSON.stringify({
  data: [
    { id: 'gpt-4o', kind: 'chat' },
    { id: 'ru-embed', kind: 'embedding' },
  ],
});

describe('probePlatform: пять исходов', () => {
  it('удача: список моделей, матрица возможностей и подпись про кэш ключа', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply(MODELS),
    });

    expect(result.outcome).toBe('ok');
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([
      { id: 'gpt-4o', kind: 'chat' },
      { id: 'ru-embed', kind: 'embedding' },
    ]);
    // Отозванный ключ какое-то время ещё принимается — удачная проверка этого
    // не опровергает, и подпись едет вместе с ответом.
    expect(result.compromises).toContain('key-cache-lag');
    expect(result.url).toBe('https://api.dev.example.ru/v1/models');
  });

  it('`type: "model"` — не объявление вида: чат остаётся «не объявлено», а не «нет»', async () => {
    // Поле вида ищется по нескольким именам, и среди них есть общие: часть
    // шлюзов кладёт в `type` совсем другое. Прочитать это как вид значило бы
    // объявить от имени контура «моделей чата ключу не выдано» — отказ, за
    // которым человек пойдёт чинить права ключа, ни разу не отказанные.
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply(JSON.stringify({ data: [{ id: 'gpt-4o', type: 'model' }] })),
    });

    const chat = result.capabilities.find((finding) => finding.id === 'chat');
    expect(chat?.state).toBe('unknown');
    expect(chat?.detail).toBe('вид моделей не объявлен');
    // Прочитанное поле при этом не выбрасывается: на экране контур говорит
    // ровно то, что написал сам.
    expect(result.models[0]?.kind).toBe('model');
  });

  it('без ключа подпись про кэш не приезжает: кэшировать нечего', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: undefined,
      fetchImpl: reply(MODELS),
    });
    expect(result.compromises).not.toContain('key-cache-lag');
  });

  it('401 — ключ отклонён, и это сказано словами, а не кодом', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-dead',
      fetchImpl: reply('{"error":"invalid api key"}', { status: 401 }),
    });

    expect(result.outcome).toBe('unauthorized');
    expect(result.reachable).toBe(true);
    // Кнопка проверки говорит ровно то же, что шлюз: причин пять, и совет
    // «перевыпустите ключ» отправлял бы четверых из пяти чинить не то.
    expect(result.detail).toContain('Их пять');
    expect(result.detail).toContain('сверка владельца');
    expect(result.detail).not.toContain('Перевыпустите');
    expect(result.models).toEqual([]);
  });

  it('403 — ключу не разрешено, и это НЕ то же самое, что 401', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('{}', { status: 403 }),
    });

    expect(result.outcome).toBe('unauthorized');
    expect(result.detail).toContain('права ключа');
  });

  it('503 — контур ещё поднимается, а не «моделей нет»', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('{"detail":"registry_not_loaded"}', { status: 503 }),
    });

    expect(result.outcome).toBe('not-ready');
    expect(result.detail).toContain('поднимается');
  });

  it('500 — сторона контура, повторить позже', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('oops', { status: 500 }),
    });
    expect(result.outcome).toBe('not-ready');
    expect(result.detail).toContain('500');
  });

  it('HTML вместо JSON — адрес админки назван отдельным сообщением', async () => {
    const admin: Platform = { ...BASE, baseUrl: 'https://enterprise-platform.example.ru' };
    const result = await probePlatform({
      platform: admin,
      token: 'sk-live',
      fetchImpl: reply('<!doctype html><title>Вход</title>', { contentType: 'text/html' }),
    });

    expect(result.outcome).toBe('not-api');
    expect(result.detail).toContain('HTML');
    expect(result.detail).toContain('админки');
  });

  it('404 на api-хосте — «не то», но про админку не выдумываем', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('not found', { status: 404 }),
    });

    expect(result.outcome).toBe('not-api');
    expect(result.detail).not.toContain('админки');
  });

  it('произвольному шлюзу про «api.<домен>» не рассказывают: это не его правило', async () => {
    // Собственный шлюз компании законно называется llm.corp.ru. Совет про
    // api.<домен> верен для одной платформы и был бы выдумкой для этой.
    const gateway: Platform = {
      ...BASE,
      driver: 'openai-compat',
      baseUrl: 'https://llm.corp.example.ru',
    };
    const result = await probePlatform({
      platform: gateway,
      token: 'sk-live',
      fetchImpl: reply('not found', { status: 404 }),
    });

    expect(result.outcome).toBe('not-api');
    expect(result.detail).not.toContain('админки');
  });

  it('JSON без списка моделей — тоже «не то», с названной причиной', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('{"hello":"world"}'),
    });

    expect(result.outcome).toBe('not-api');
    expect(result.detail).toContain('data');
  });

  it('не JSON при 200 — разобрано как «не то», а не как пустой список', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: 'sk-live',
      fetchImpl: reply('просто текст', { contentType: 'text/plain' }),
    });

    expect(result.outcome).toBe('not-api');
    expect(result.detail).toContain('JSON');
  });

  it('вышло время — «не ответил за 15 с», а не стек ошибки', async () => {
    const timeout: PlatformFetch = () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    };
    const result = await probePlatform({ platform: BASE, token: 'sk', fetchImpl: timeout });

    expect(result.outcome).toBe('unreachable');
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('15');
  });

  it('чужой сертификат — подсказка про корневой сертификат компании', async () => {
    const tls: PlatformFetch = () =>
      Promise.reject(new Error('self-signed certificate in certificate chain'));
    const result = await probePlatform({ platform: BASE, token: 'sk', fetchImpl: tls });

    expect(result.outcome).toBe('unreachable');
    expect(result.detail).toContain('корневой сертификат');
  });

  it('адрес не http(s) — отказ ДО сети', async () => {
    let called = false;
    const spy: PlatformFetch = () => {
      called = true;
      return Promise.resolve(new Response('{}'));
    };
    const result = await probePlatform({
      platform: { ...BASE, baseUrl: 'file:///etc/passwd' },
      token: 'sk',
      fetchImpl: spy,
    });

    expect(result.outcome).toBe('unreachable');
    expect(called).toBe(false);
  });
});

describe('probePlatform: ключ и адрес', () => {
  it('ключ уходит только в заголовок и не появляется ни в адресе, ни в ответе', async () => {
    const secret = 'sk-СЕКРЕТ-4f21';
    let seenUrl = '';
    let seenAuth = '';
    const spy: PlatformFetch = (url, init) => {
      seenUrl = url;
      seenAuth = init?.headers?.authorization ?? '';
      return Promise.resolve(
        new Response(MODELS, { headers: { 'content-type': 'application/json' } }),
      );
    };

    const result = await probePlatform({ platform: BASE, token: secret, fetchImpl: spy });

    expect(seenAuth).toBe(`Bearer ${secret}`);
    expect(seenUrl).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('адрес с версией не получает вторую /v1', async () => {
    let seenUrl = '';
    const spy: PlatformFetch = (url) => {
      seenUrl = url;
      return Promise.resolve(
        new Response(MODELS, { headers: { 'content-type': 'application/json' } }),
      );
    };

    await probePlatform({
      platform: { ...BASE, driver: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1' },
      token: undefined,
      fetchImpl: spy,
    });

    expect(seenUrl).toBe('http://127.0.0.1:11434/v1/models');
  });

  it('ключ, не пролезающий в заголовок, назван ключом, а не «нет связи»', async () => {
    // Заглушки здесь нет намеренно: ошибку рождает САМ транспорт, когда
    // складывает заголовок из символа выше 255. Подменённый `fetch` доказал бы
    // только текст, который я сам и придумал, — поэтому запрос идёт настоящим
    // `fetch` на заведомо мёртвый порт: до сети дело не доходит вовсе, ключ
    // отваливается раньше.
    const result = await probePlatform({
      platform: { ...BASE, baseUrl: 'http://127.0.0.1:1' },
      token: 'sk-live-ключ',
    });

    expect(result.outcome).not.toBe('ok');
    expect(result.detail).toMatch(/Ключ контура не годится для заголовка/);
    expect(result.detail).not.toMatch(/ByteString/);
  });

  it('чужое тело ошибки обрезается', async () => {
    const long = 'x'.repeat(5_000);
    const result = await probePlatform({
      platform: BASE,
      token: 'sk',
      fetchImpl: reply(long, { status: 400, contentType: 'text/plain' }),
    });

    expect(result.detail.length).toBeLessThan(700);
  });

  it('ОТРАЖЁННЫЙ КЛЮЧ не доезжает до ответа: чужой текст чистится, а не режется', async () => {
    const secret = 'sk-КОРПОРАТИВНЫЙ-КЛЮЧ-4f21';
    const result = await probePlatform({
      platform: BASE,
      token: secret,
      // Ровно то, что делают настоящие шлюзы: кладут присланный ключ в текст
      // отказа. Обрезка до 300 символов тут не спасает — ключ в первых словах.
      fetchImpl: reply(`{"error":"unknown api key ${secret}"}`, { status: 400 }),
    });

    expect(result.detail).not.toContain(secret);
    expect(result.detail).toContain('«ключ»');
    // Остальной текст чужого отказа человеку по-прежнему виден.
    expect(result.detail).toContain('unknown api key');
  });

  it('чужой секрет в теле убирается по форме, даже когда он не наш', async () => {
    const result = await probePlatform({
      platform: BASE,
      token: undefined,
      fetchImpl: reply('proxy rejected: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc', {
        status: 400,
        contentType: 'text/plain',
      }),
    });

    expect(result.detail).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('ключ не просачивается и через текст ошибки транспорта', async () => {
    const secret = 'sk-КОРПОРАТИВНЫЙ-КЛЮЧ-4f21';
    const leaky: PlatformFetch = () =>
      Promise.reject(new Error(`socket hang up (headers: authorization: Bearer ${secret})`));

    const result = await probePlatform({ platform: BASE, token: secret, fetchImpl: leaky });

    expect(result.detail).not.toContain(secret);
  });
});
