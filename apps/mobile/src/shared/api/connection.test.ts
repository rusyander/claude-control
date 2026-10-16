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

/** Токен выбранного компьютера, где бы он ни лежал. */
const tokenOf = (where: Storage | Map<string, string>, id: string) =>
  where instanceof Map ? where.get(`panels.token.${id}`) : where.getItem(`panels.token.${id}`);

describe('хранилище подключения', () => {
  beforeEach(() => {
    platform.OS = 'web';
    secure.clear();
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
  });

  it('веб: токен и адрес — в sessionStorage, в localStorage ничего', async () => {
    const connection = await load();
    const id = await connection.saveConnection('mac.tail.ts.net/', ' secret ');
    expect(localStorage.length).toBe(0);
    expect(tokenOf(sessionStorage, id)).toBe('secret');
    expect(sessionStorage.getItem('panels.v1')).toContain('http://mac.tail.ts.net');
    const again = await load();
    expect(await again.loadConnection()).toMatchObject({
      url: 'http://mac.tail.ts.net',
      token: 'secret',
      activeId: id,
      ready: true,
    });
  });

  it('веб: пара, оставленная в localStorage прежней сборкой, становится первым компьютером', async () => {
    localStorage.setItem('panel.url', 'http://old');
    localStorage.setItem('panel.token', 'old-secret');
    const connection = await load();
    const loaded = await connection.loadConnection();
    expect(loaded).toMatchObject({ url: 'http://old', token: 'old-secret' });
    expect(loaded.panels).toHaveLength(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.getItem('panel.token')).toBeNull();
    expect(sessionStorage.getItem('panel.url')).toBeNull();
    expect(tokenOf(sessionStorage, loaded.activeId)).toBe('old-secret');
  });

  it('веб: «Отключить» стирает выбранный компьютер из обоих хранилищ', async () => {
    const connection = await load();
    const id = await connection.saveConnection('http://a', 't');
    localStorage.setItem(`panels.token.${id}`, 'stale');
    await connection.clearConnection();
    expect(tokenOf(sessionStorage, id)).toBeNull();
    expect(tokenOf(localStorage, id)).toBeNull();
    expect(connection.currentConnection()).toMatchObject({ url: '', token: '', panels: [] });
  });

  it('телефон: пара в SecureStore, хранилища браузера не трогаются', async () => {
    platform.OS = 'android';
    const connection = await load();
    const id = await connection.saveConnection('http://a', 't');
    expect(tokenOf(secure, id)).toBe('t');
    expect(sessionStorage.length + localStorage.length).toBe(0);
  });

  it('телефон: старая пара из SecureStore переезжает в список и стирается', async () => {
    platform.OS = 'android';
    secure.set('panel.url', 'http://desk:5178');
    secure.set('panel.token', 'desk-token');
    const connection = await load();
    const loaded = await connection.loadConnection();
    expect(loaded).toMatchObject({ url: 'http://desk:5178', token: 'desk-token' });
    expect(secure.has('panel.url') || secure.has('panel.token')).toBe(false);
  });
});

describe('несколько компьютеров', () => {
  beforeEach(() => {
    platform.OS = 'android';
    secure.clear();
  });

  const desk = { platform: 'win32', machineName: 'DESKTOP-7Q', machineId: 'm-desk' };

  it('второй компьютер добавляется и выбирается; переключение меняет пару для запросов', async () => {
    const connection = await load();
    const first = await connection.saveConnection('http://desk:5178', 'desk-token');
    const second = await connection.saveConnection('https://mac.tail.ts.net', 'mac-token');
    expect(connection.currentConnection()).toMatchObject({
      url: 'https://mac.tail.ts.net',
      token: 'mac-token',
      activeId: second,
    });
    await connection.switchPanel(first);
    expect(connection.currentConnection()).toMatchObject({
      url: 'http://desk:5178',
      token: 'desk-token',
    });
    // Выбор переживает перезапуск.
    const again = await load();
    expect((await again.loadConnection()).activeId).toBe(first);
  });

  it('тот же компьютер по новому адресу склеивается: имя человека остаётся, токен — свежий', async () => {
    const connection = await load();
    const home = await connection.saveConnection('http://192.168.1.5:5178', 'old-token');
    await connection.describePanel(home, desk);
    await connection.renamePanel(home, 'Дом');
    const fresh = await connection.saveConnection('https://desk.tail.ts.net', 'new-token');
    await connection.describePanel(fresh, desk);
    const now = connection.currentConnection();
    expect(now.panels).toHaveLength(1);
    expect(now).toMatchObject({
      activeId: home,
      url: 'https://desk.tail.ts.net',
      token: 'new-token',
    });
    expect(now.panels[0]?.name).toBe('Дом');
    expect(tokenOf(secure, fresh)).toBeUndefined();
  });

  it('убрали выбранный — выбран оставшийся, его токен на месте', async () => {
    const connection = await load();
    const first = await connection.saveConnection('http://desk:5178', 'desk-token');
    const second = await connection.saveConnection('http://mac:5178', 'mac-token');
    await connection.removePanel(second);
    expect(connection.currentConnection()).toMatchObject({ activeId: first, token: 'desk-token' });
    expect(tokenOf(secure, second)).toBeUndefined();
  });
});
