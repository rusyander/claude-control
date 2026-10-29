import { describe, expect, it } from 'vitest';
import { newId } from '../../lib/ids/uuidv7.ts';
import { createSessionTokens } from './session-tokens.ts';

/**
 * Токен сессии выводится из ключа ядра: тот же ключ после перезапуска ядра узнаёт токен
 * живой сессии, чужой ключ и любая правка токена — нет (06 §Authority, P41).
 */

describe('session tokens', () => {
  const key = 'core-token-0123456789abcdef';

  it('P41 a minted token verifies under the same key only; any edit or a foreign session id fails', () => {
    const taskId = newId();
    const sessionId = newId();
    const token = createSessionTokens(key).mint({ taskId, sessionId });
    // Новое ядро с тем же ключом (перезапуск) узнаёт токен — сессия переживает ядро.
    expect(createSessionTokens(key).verify(token)).toEqual({ taskId, sessionId });
    expect(createSessionTokens(`${key}-other`).verify(token)).toBeUndefined();
    const [prefix, t, , mac] = token.split('.');
    expect(createSessionTokens(key).verify([prefix, t, newId(), mac].join('.'))).toBeUndefined();
    // Первый знак подписи несёт полные 6 бит: его замена всегда меняет байты.
    const swapped = `${(mac ?? '')[0] === 'A' ? 'B' : 'A'}${(mac ?? '').slice(1)}`;
    expect(
      createSessionTokens(key).verify([prefix, t, sessionId, swapped].join('.')),
    ).toBeUndefined();
    expect(createSessionTokens(key).verify(`${token}.x`)).toBeUndefined();
    expect(createSessionTokens(key).verify('')).toBeUndefined();
    expect(createSessionTokens(key).verify(key)).toBeUndefined();
  });

  it('refuses a short key and non-UUIDv7 ids', () => {
    expect(() => createSessionTokens('short')).toThrow();
    expect(() => createSessionTokens(key).mint({ taskId: 'x', sessionId: newId() })).toThrow();
  });
});
