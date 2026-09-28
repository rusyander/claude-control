import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Где веб-сборка Expo держит адрес и токен (F-22). Токен равен полному доступу
 * к машине: в localStorage он переживал закрытие вкладки и читался любым
 * скриптом того же origin навсегда. На телефоне пара по-прежнему в SecureStore.
 */

const platform = vi.hoisted(() => ({ OS: 'web' as 'web' | 'android' }));
const secure = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void secure.set(key, value),
  deleteItemAsync: async (key: string) => void secure.delete(key),
}));

/** Хранилище браузера в памяти — то же API, что у `Storage`. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const load = async () => {
  vi.resetModules();
  return import('./connection');
};

describe('хранилище подключения', () => {
  beforeEach(() => {
    platform.OS = 'web';
    secure.clear();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  it('веб: токен и адрес — в sessionStorage, в localStorage ничего', async () => {
    const connection = await load();
    await connection.saveConnection('mac.tail.ts.net/', ' secret ');
    expect(localStorage.getItem('panel.token')).toBeNull();
    expect(localStorage.getItem('panel.url')).toBeNull();
    expect(sessionStorage.getItem('panel.token')).toBe('secret');
    expect(sessionStorage.getItem('panel.url')).toBe('http://mac.tail.ts.net');
    const again = await load();
    expect(await again.loadConnection()).toMatchObject({
      url: 'http://mac.tail.ts.net',
      token: 'secret',
      ready: true,
    });
  });

  it('веб: пара, оставленная в localStorage прежней сборкой, переезжает и стирается', async () => {
    localStorage.setItem('panel.url', 'http://old');
    localStorage.setItem('panel.token', 'old-secret');
    const connection = await load();
    expect(await connection.loadConnection()).toMatchObject({
      url: 'http://old',
      token: 'old-secret',
    });
    expect(localStorage.getItem('panel.token')).toBeNull();
    expect(localStorage.getItem('panel.url')).toBeNull();
    expect(sessionStorage.getItem('panel.token')).toBe('old-secret');
  });

  it('веб: «Отключить» стирает пару из обоих хранилищ', async () => {
    localStorage.setItem('panel.token', 'old-secret');
    const connection = await load();
    await connection.saveConnection('http://a', 't');
    await connection.clearConnection();
    expect(sessionStorage.getItem('panel.token')).toBeNull();
    expect(localStorage.getItem('panel.token')).toBeNull();
  });

  it('телефон: пара в SecureStore, хранилища браузера не трогаются', async () => {
    platform.OS = 'android';
    const connection = await load();
    await connection.saveConnection('http://a', 't');
    expect(secure.get('panel.token')).toBe('t');
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });
});
