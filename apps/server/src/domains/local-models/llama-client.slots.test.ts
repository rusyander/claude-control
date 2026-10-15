import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { llamaClient } from './llama-client.ts';
import type { FetchLike } from './download.ts';

/**
 * Разбор `GET /slots` на настоящем ответе llama-server b11583 (ревью m5): снимки сняты с живого
 * сервера — простой слот, разбор промпта пакетами по 256 и выдача ответа. По `filled` и
 * `decoded` присмотр (`activity.ts`) видит движение; ошибись разбор — он видел бы тишину и
 * обрывал здоровый запрос, или не видел бы застывшего.
 */

const sample = JSON.parse(
  readFileSync(new URL('./__fixtures__/slots-b11583.json', import.meta.url), 'utf8'),
) as Record<'idle' | 'prompt' | 'generating', unknown>;

function serving(body: unknown, status = 200): FetchLike {
  return async (input) => {
    expect(String(input)).toBe('http://127.0.0.1:11435/slots');
    return Response.json(body, { status });
  };
}

const client = (fetchImpl: FetchLike) => llamaClient('http://127.0.0.1:11435', fetchImpl);

describe('опрос слота llama-server (b11583)', () => {
  it('простой слот: не занят, промпта и ответа нет', async () => {
    expect(await client(serving(sample.idle)).slot(0)).toEqual({
      processing: false,
      filled: 0,
      decoded: 0,
    });
  });

  it('разбор промпта: `n_prompt_tokens` — сколько уже в кеше (пакет 256), ответа ещё нет', async () => {
    expect(await client(serving(sample.prompt)).slot(0)).toEqual({
      processing: true,
      filled: 256,
      decoded: 0,
    });
  });

  it('выдача ответа: весь промпт в кеше, `next_token[0].n_decoded` — выданные токены', async () => {
    expect(await client(serving(sample.generating)).slot(0)).toEqual({
      processing: true,
      filled: 1590,
      decoded: 22,
    });
  });

  it('другого слота нет, сервер без каталога слотов — пусто; сбой сети — отказ, его считает присмотр', async () => {
    expect(await client(serving(sample.prompt)).slot(1)).toBeUndefined();
    expect(await client(serving({ error: 'not supported' }, 501)).slot(0)).toBeUndefined();
    const down: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(client(down).slot(0)).rejects.toThrow('fetch failed');
  });
});
