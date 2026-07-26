import { describe, it, expect } from 'vitest';
import { allowedOrigins, isRequestAllowed, type GuardedRequest } from './origin-guard.ts';

/**
 * Кто допущен к API. У него нет аутентификации, поэтому этот фильтр —
 * единственная защита панели; проверяем именно граничные случаи, а не
 * «свой Origin проходит».
 */
describe('origin-guard', () => {
  const allowed = allowedOrigins(8888);
  const ask = (extra: Partial<GuardedRequest>): boolean =>
    isRequestAllowed(
      { method: 'GET', url: '/api/analytics/pricing?refresh=true', ...extra },
      allowed,
    );

  it('своему интерфейсу разрешено: GET на свой источник Origin не несёт', () => {
    expect(ask({ site: 'same-origin' })).toBe(true);
    expect(ask({ origin: 'http://localhost:8888', site: 'same-origin' })).toBe(true);
    expect(ask({ origin: 'http://127.0.0.1:8888', site: 'same-origin' })).toBe(true);
  });

  it('переход по адресу и не-браузерный клиент (curl) проходят', () => {
    expect(ask({ site: 'none' })).toBe(true);
    expect(ask({})).toBe(true);
  });

  it('страница с ДРУГОГО порта localhost без Origin отклоняется', () => {
    // Регрессия: порт в понятие «site» не входит, поэтому <img> со страницы
    // http://localhost:3000 (в т.ч. dev-сервера, запущенного самой панелью)
    // приходит без Origin и с Sec-Fetch-Site: same-site — и раньше выполнялся.
    expect(ask({ site: 'same-site' })).toBe(false);
  });

  it('чужой сайт отклоняется и по Origin, и по Sec-Fetch-Site', () => {
    expect(ask({ origin: 'http://evil.example', site: 'cross-site' })).toBe(false);
    expect(ask({ origin: 'http://evil.example' })).toBe(false);
    expect(ask({ site: 'cross-site' })).toBe(false);
    // Свой порт, но другая схема/хост — не наш интерфейс.
    expect(ask({ origin: 'https://localhost:8888', site: 'same-site' })).toBe(false);
  });

  it('возврат OAuth MCP остаётся исключением: он всегда cross-site', () => {
    const callback = {
      method: 'GET',
      url: '/api/mcp/oauth/callback?code=abc&state=xyz',
      site: 'cross-site',
    };
    expect(isRequestAllowed(callback, allowed)).toBe(true);

    // Исключение ровно на этот GET: тем же адресом ничего не отправить.
    expect(isRequestAllowed({ ...callback, method: 'POST' }, allowed)).toBe(false);
    expect(
      isRequestAllowed({ ...callback, url: '/api/mcp/oauth/callback/../../env/reveal' }, allowed),
    ).toBe(false);
  });
});
