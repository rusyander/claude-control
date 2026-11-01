import { afterEach, describe, expect, it } from 'vitest';
import { setStoredKey } from '@agentdeck/keys/provider-keys';
import {
  anthropicBody,
  ask,
  filesContaining,
  hopStand,
  type HopStand,
} from './__fixtures__/hop-stand.ts';

/**
 * Как ключ уходит наверх (W2b, follow-up), на настоящем хосте звеньев и подставном контуре:
 * свой заголовок и слово карточки контура, ключ пресета Azure (`api-key` без слова), постоянные
 * заголовки и параметры адреса, корень версии без удвоения `/v1`, ключ `env` из пина задачи в
 * памяти метки и отказ регистрации перевода, которого мост не умеет. Наблюдатель стенда видит
 * СЫРЫЕ заголовки запроса наверх.
 */

const j = (...parts: string[]): string => parts.join('');
// Значения собираются из кусков: целым литералом они попали бы в сканер секретов репозитория.
const STORE_KEY = j('contour', '-store-', 'w2b-0123456789');
const PIN_KEY = j('pin', '-session-', 'w2b-5555555555');

let stand: HopStand | undefined;
afterEach(async () => {
  await stand?.close().catch(() => undefined);
  stand = undefined;
});

async function contour(script: string[]): Promise<HopStand> {
  return hopStand({
    script,
    prepare: (appData) => setStoredKey(appData, 'contour-key', STORE_KEY),
  });
}

const carrying = (
  headers: Record<string, string | string[] | undefined>,
  needle: string,
): string[] =>
  Object.entries(headers)
    .filter(([, value]) => String(value ?? '').includes(needle))
    .map(([name]) => name);

describe('hop upstream auth (W2b follow-up)', () => {
  it('own contour header and scheme: the key goes in X-Auth with "Token", fixed headers ride along and cannot overwrite it', async () => {
    stand = await contour(['own header answer']);
    const reply = await stand.register({
      to: 'openai-chat',
      keyRef: { kind: 'panel-store', name: 'contour-key' },
      upstreamAuth: { header: 'x-auth', scheme: 'Token' },
      upstreamHeaders: { 'x-tenant': 't1', 'X-Auth': 'spoofed' },
    });
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('own header answer');
    const headers = stand.seen[0]!.headers;
    expect(headers['x-auth']).toBe(`Token ${STORE_KEY}`);
    expect(headers['x-tenant']).toBe('t1');
    // Ключ — только в своём заголовке, не в `Authorization` диалекта.
    expect(carrying(headers, STORE_KEY)).toEqual(['x-auth']);
    expect(headers.authorization).toBeUndefined();
  });

  it('Azure preset: api-key without a scheme, api-version as a query, version root not doubled', async () => {
    stand = await contour(['azure answer']);
    const reply = await stand.register({
      to: 'openai-chat',
      upstream: `${stand.stub.baseUrl}/openai/v1`,
      keyRef: { kind: 'panel-store', name: 'contour-key' },
      upstreamAuth: { header: 'api-key', scheme: '' },
      upstreamQuery: { 'api-version': 'preview' },
      upstreamRooted: true,
    });
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(200);
    const seen = stand.seen[0]!;
    expect(seen.path).toBe('/openai/v1/chat/completions');
    expect(new URLSearchParams(seen.query ?? '').get('api-version')).toBe('preview');
    expect(seen.headers['api-key']).toBe(STORE_KEY);
    expect(carrying(seen.headers, STORE_KEY)).toEqual(['api-key']);
  });

  it('env key from the task pin: lives in the tag memory, goes upstream as Bearer, never on disk; absent → refused', async () => {
    stand = await contour(['pin key answer']);
    const keyRef = { kind: 'env' as const, name: 'LLAMA_ACCESS_W2B' };
    const reply = await stand.register({ to: 'openai-chat', keyRef }, PIN_KEY);
    const answer = await ask(reply.port, reply.placeholder, 'anthropic', anthropicBody('x'));
    expect(answer.status).toBe(200);
    expect(stand.seen[0]!.headers.authorization).toBe(`Bearer ${PIN_KEY}`);
    expect(filesContaining(stand.home, PIN_KEY)).toEqual([]);
    // Без значения ключа сеанса — окружение хоста, а там переменной нет: отказ, наверх ничего.
    const bare = await stand.register({ to: 'openai-chat', keyRef });
    const refused = await ask(bare.port, bare.placeholder, 'anthropic', anthropicBody('x'));
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(stand.seen).toHaveLength(1);
  });

  it('a translation the bridge cannot do is refused at registration', async () => {
    stand = await contour(['never']);
    await expect(
      stand.register({ from: 'openai-chat', to: 'anthropic-messages' }),
    ).rejects.toMatchObject({ code: 'unknown_translation' });
    await expect(stand.register({ to: 'google-genai' })).rejects.toMatchObject({
      code: 'unknown_translation',
    });
  });
});
