import { describe, expect, it } from 'vitest';
import { keyEnv } from './caller-env.ts';

/**
 * Окружение ключа: ядро — свой пин, вызывающий — пин и поверх его значения имён прокладки.
 * Сквозной путь (ручка захвата → вход → ключ → хранилище) — `capture.integration.test.ts`.
 */

const PIN = { PATH: '/core/bin', HOME: '/h' };

describe('key env: core pin, the caller env laid over it on capture roads', () => {
  it('a core run keys by the pin alone, caller values ignored even if present', () => {
    expect(keyEnv(PIN, { exec: 'core', callerEnv: { CI: '1' } })).toEqual(PIN);
    expect(keyEnv(PIN, { exec: 'caller' })).toEqual(PIN);
  });

  it('a caller run: a value overrides or adds, null removes the name, the pin itself is not mutated', () => {
    const pin = { ...PIN };
    expect(keyEnv(pin, { exec: 'caller', callerEnv: { CI: '1', HOME: null, TZ: null } })).toEqual({
      PATH: '/core/bin',
      CI: '1',
    });
    expect(pin).toEqual(PIN);
  });

  it('names match without case, like the key part: Path of the caller replaces PATH of the pin', () => {
    expect(keyEnv(PIN, { exec: 'caller', callerEnv: { Path: '/caller/bin' } })).toEqual({
      HOME: '/h',
      Path: '/caller/bin',
    });
    expect(keyEnv(PIN, { exec: 'caller', callerEnv: { path: null } })).toEqual({ HOME: '/h' });
  });
});
