import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_TRANSFER_TARGET_KEY,
  TRANSFER_TARGET_KEY,
  readRememberedTarget,
  rememberTarget,
} from './target-memory';

/** Storage поверх Map: тесты идут в node, где браузерного хранилища нет. */
function memoryStorage(initial: Record<string, string>): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('память цели переноса (F-248)', () => {
  it('ключ — по общему образцу agentdeck:…', () => {
    const storage = memoryStorage({});
    vi.stubGlobal('localStorage', storage);
    rememberTarget('codex');
    expect(storage.getItem('agentdeck:portability-target')).toBe('codex');
    expect(TRANSFER_TARGET_KEY).toBe('agentdeck:portability-target');
  });

  it('выбор под прежним ключом читается один раз и переезжает под новый', () => {
    const storage = memoryStorage({ [LEGACY_TRANSFER_TARGET_KEY]: 'gemini' });
    vi.stubGlobal('localStorage', storage);
    expect(readRememberedTarget()).toBe('gemini');
    expect(storage.getItem(TRANSFER_TARGET_KEY)).toBe('gemini');
    expect(storage.getItem(LEGACY_TRANSFER_TARGET_KEY)).toBeNull();
  });

  it('стёртый выбор не воскресает из прежнего ключа', () => {
    const storage = memoryStorage({
      [LEGACY_TRANSFER_TARGET_KEY]: 'gemini',
      [TRANSFER_TARGET_KEY]: 'codex',
    });
    vi.stubGlobal('localStorage', storage);
    rememberTarget('');
    expect(readRememberedTarget()).toBe('');
  });

  it('недоступное хранилище — не сбой', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readRememberedTarget()).toBe('');
    expect(() => rememberTarget('codex')).not.toThrow();
  });
});
