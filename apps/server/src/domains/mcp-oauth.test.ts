import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@claude-control/contracts';
import {
  hasOAuthTokens,
  clearOAuth,
  renameOAuth,
  startOAuth,
  oauthStorePath,
  oauthCallbackUrl,
  oauthCallbackPage,
  oauthProviderFor,
} from './mcp-oauth.ts';

/**
 * Хранилище и границы интерактивного OAuth.
 *
 * Полный поток (обнаружение сервера авторизации, DCR, обмен кода на токен)
 * ведёт SDK и проверяется живым сервером в Фазе тестирования; здесь — то, что
 * относится к приложению: где лежат токены и какими правами, что stdio входа не
 * знает, и что страница возврата собирается без внешних зависимостей.
 *
 * Всё пишется во временный каталог — настоящий ~/.claude не затрагивается.
 */
describe('mcp-oauth', () => {
  let appData: string;

  const networkServer = (overrides: Partial<McpServer> = {}): McpServer => ({
    id: 'remote',
    name: 'remote',
    transport: 'http',
    args: [],
    env: {},
    headers: {},
    url: 'https://example.test/mcp',
    health: 'unknown',
    isEnabled: true,
    groupIds: [],
    hasOAuth: false,
    ...overrides,
  });

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'cc-mcp-oauth-'));
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
  });

  describe('хранилище токенов', () => {
    it('пустое хранилище — токенов нет', () => {
      expect(hasOAuthTokens(appData, 'remote')).toBe(false);
    });

    it('сохранённый токен виден, а сброс его убирает', async () => {
      // Токены обычно сохраняет SDK через провайдер; здесь дёргаем его напрямую,
      // чтобы не поднимать сервер авторизации.
      const provider = oauthProviderFor(networkServer(), appData) as unknown as {
        saveTokens(t: { access_token: string; token_type: string }): Promise<void>;
      };
      await provider.saveTokens({ access_token: 'secret-abc', token_type: 'Bearer' });

      expect(hasOAuthTokens(appData, 'remote')).toBe(true);

      await clearOAuth(appData, 'remote');
      expect(hasOAuthTokens(appData, 'remote')).toBe(false);
    });

    it('файл хранилища создаётся с правами 600', async function () {
      if (process.platform === 'win32') return; // POSIX-права на Windows не действуют

      const provider = oauthProviderFor(networkServer(), appData) as unknown as {
        saveTokens(t: { access_token: string; token_type: string }): Promise<void>;
      };
      await provider.saveTokens({ access_token: 'secret-abc', token_type: 'Bearer' });

      const path = oauthStorePath(appData);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });

  describe('переименование сервера', () => {
    const saveTokenFor = (id: string): Promise<void> => {
      const provider = oauthProviderFor(networkServer({ id, name: id }), appData) as unknown as {
        saveTokens(t: { access_token: string; token_type: string }): Promise<void>;
      };
      return provider.saveTokens({ access_token: `secret-${id}`, token_type: 'Bearer' });
    };

    it('вход переезжает на новое имя, старый ключ не остаётся', async () => {
      // Иначе refresh-токен висел бы в файле под мёртвым именем, а пользователю
      // пришлось бы авторизоваться заново.
      await saveTokenFor('linear');

      await renameOAuth(appData, 'linear', 'linear-mcp');

      expect(hasOAuthTokens(appData, 'linear-mcp')).toBe(true);
      expect(hasOAuthTokens(appData, 'linear')).toBe(false);
    });

    it('права 600 у файла сохраняются', async function () {
      if (process.platform === 'win32') return; // POSIX-права на Windows не действуют

      await saveTokenFor('linear');
      await renameOAuth(appData, 'linear', 'linear-mcp');

      expect(statSync(oauthStorePath(appData)).mode & 0o777).toBe(0o600);
    });

    it('переименование сервера без входа ничего не создаёт', async () => {
      await expect(renameOAuth(appData, 'нет-такого', 'новый')).resolves.toBeUndefined();
      expect(existsSync(oauthStorePath(appData))).toBe(false);
    });

    it('переименование НЕ наследует токен, лежащий под новым именем', async () => {
      // Утечка: под именем «beta» остался вход прежнего сервера, у «alpha» входа
      // не было — и перенос молча выходил, оставляя чужой токен. Панель показывала
      // «авторизован», а проверка связи и список инструментов слали чужой
      // access_token на адрес alpha. Переименование не может выдать доступ.
      await saveTokenFor('beta');

      await renameOAuth(appData, 'alpha', 'beta');

      expect(hasOAuthTokens(appData, 'beta')).toBe(false);
      expect(readFileSync(oauthStorePath(appData), 'utf8')).not.toContain('secret-beta');
    });

    it('переименование поверх чужого входа кладёт свой, а не оба', async () => {
      await saveTokenFor('alpha');
      await saveTokenFor('beta');

      await renameOAuth(appData, 'alpha', 'beta');

      const raw = readFileSync(oauthStorePath(appData), 'utf8');
      expect(raw).toContain('secret-alpha');
      expect(raw).not.toContain('secret-beta');
      expect(hasOAuthTokens(appData, 'alpha')).toBe(false);
    });
  });

  describe('границы', () => {
    it('stdio-сервер входа не знает', async () => {
      await expect(
        startOAuth(networkServer({ transport: 'stdio', url: undefined }), appData),
      ).rejects.toThrow(/http\/sse/);
    });

    it('адрес возврата указывает на порт API и петлевой IP', () => {
      expect(oauthCallbackUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/mcp\/oauth\/callback$/);
    });

    it('адрес возврата берёт порт из переменной окружения PORT', () => {
      const saved = process.env.PORT;
      process.env.PORT = '6001';
      try {
        expect(oauthCallbackUrl()).toBe('http://127.0.0.1:6001/api/mcp/oauth/callback');
      } finally {
        if (saved === undefined) delete process.env.PORT;
        else process.env.PORT = saved;
      }
    });

    it('сброс несуществующего сервера не бросает исключение', async () => {
      await expect(clearOAuth(appData, 'нет-такого')).resolves.toBeUndefined();
      expect(hasOAuthTokens(appData, 'нет-такого')).toBe(false);
    });
  });

  describe('провайдер и хранилище', () => {
    // Провайдер — внутренний класс; дёргаем его методы напрямую, чтобы не
    // поднимать сервер авторизации. Форма токенов/регистрации — как у SDK.
    type Store = {
      saveClientInformation(c: { client_id: string }): Promise<void>;
      clientInformation(): { client_id: string } | undefined;
      saveTokens(t: {
        access_token: string;
        token_type: string;
        refresh_token?: string;
      }): Promise<void>;
      tokens(): { access_token: string } | undefined;
      invalidateCredentials(
        scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
      ): Promise<void>;
    };
    const store = (): Store => oauthProviderFor(networkServer(), appData) as unknown as Store;

    it('регистрация клиента переживает перезапись и читается обратно', async () => {
      const provider = store();
      await provider.saveClientInformation({ client_id: 'abc' });
      // Новый экземпляр читает то же хранилище — регистрация не в памяти, а в файле.
      expect(store().clientInformation()?.client_id).toBe('abc');
    });

    it('invalidateCredentials("tokens") убирает токены, но оставляет регистрацию', async () => {
      const provider = store();
      await provider.saveClientInformation({ client_id: 'abc' });
      await provider.saveTokens({ access_token: 't', token_type: 'Bearer' });

      await provider.invalidateCredentials('tokens');

      expect(hasOAuthTokens(appData, 'remote')).toBe(false);
      expect(store().clientInformation()?.client_id).toBe('abc');
    });

    it('invalidateCredentials("all") стирает и токены, и регистрацию, и саму запись', async () => {
      const provider = store();
      await provider.saveClientInformation({ client_id: 'abc' });
      await provider.saveTokens({ access_token: 't', token_type: 'Bearer' });

      await provider.invalidateCredentials('all');

      expect(hasOAuthTokens(appData, 'remote')).toBe(false);
      expect(store().clientInformation()).toBeUndefined();
    });

    it('токены одного сервера не видны под именем другого', async () => {
      const provider = oauthProviderFor(
        networkServer({ id: 'first' }),
        appData,
      ) as unknown as Store;
      await provider.saveTokens({ access_token: 't', token_type: 'Bearer' });

      expect(hasOAuthTokens(appData, 'first')).toBe(true);
      expect(hasOAuthTokens(appData, 'second')).toBe(false);
    });

    // Гонка read-modify-write: saveClientInformation (вход) и saveTokens
    // (параллельная проверка связи, рефрешащая токен) — это чтение всего файла,
    // правка и запись целиком через асинхронные границы. Без сериализации по
    // файлу поздний писатель затёр бы чужую запись (потеря client_id или свежего
    // refresh_token). Очередь записи в mcp-oauth.ts выстраивает их в цепочку.
    it('параллельные saveClientInformation и saveTokens не теряют друг друга', async () => {
      // Два независимых провайдера одного serverId (как вход и health-check) пишут
      // одновременно, вперемешку. Обе записи должны уцелеть.
      const login = store();
      const healthCheck = store();
      await Promise.all([
        login.saveClientInformation({ client_id: 'client-xyz' }),
        healthCheck.saveTokens({ access_token: 'fresh-token', token_type: 'Bearer' }),
      ]);

      expect(store().clientInformation()?.client_id).toBe('client-xyz');
      expect(store().tokens()?.access_token).toBe('fresh-token');
    });

    it('поток из многих параллельных записей по одному серверу не теряется', async () => {
      // Череда сохранений токенов вперемешку с сохранением регистрации: последний
      // токен и регистрация должны дойти до файла — очередь их не растеряла.
      const provider = store();
      const writes: Promise<void>[] = [];
      for (let i = 0; i < 20; i += 1) {
        writes.push(provider.saveTokens({ access_token: `token-${i}`, token_type: 'Bearer' }));
      }
      writes.push(provider.saveClientInformation({ client_id: 'reg' }));
      await Promise.all(writes);

      // Регистрация уцелела рядом с токенами (её не затёрла ни одна запись токена).
      expect(store().clientInformation()?.client_id).toBe('reg');
      // Токен на месте — сохранён один из отправленных, файл не побит.
      expect(store().tokens()?.access_token).toMatch(/^token-\d+$/);
    });
  });

  describe('страница возврата', () => {
    it('успех: сообщает об удаче и закрывает окно', () => {
      const html = oauthCallbackPage(true);
      expect(html).toContain('Авторизация прошла');
      expect(html).toContain('window.close()');
    });

    it('ошибка: показывает причину и не закрывает окно', () => {
      const html = oauthCallbackPage(false, 'сервер отверг код');
      expect(html).toContain('Авторизация не удалась');
      expect(html).toContain('сервер отверг код');
      expect(html).not.toContain('window.close()');
    });

    it('текст ошибки экранируется — чужую разметку в страницу не пускаем', () => {
      const html = oauthCallbackPage(false, '<img src=x onerror=alert(1)>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img');
    });
  });
});
