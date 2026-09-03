import { describe, it, expect } from 'vitest';
import { acceptsQueryToken, isValidApiToken, presentedToken } from './api-token.ts';

/**
 * Токен доступа. Чтение и ротация трогают `~/.claude-control` — настоящий
 * каталог пользователя, поэтому здесь проверяется то, что от файла не зависит:
 * КАК токен извлекается из запроса, ГДЕ он принимается строкой запроса и КАК
 * сравнивается. Ошибка ровно здесь и означала бы дыру: принятый пустой токен,
 * принятый префикс, принятый чужой, токен в адресе там, где он осядет в логах.
 */

describe('presentedToken: откуда берётся предъявленный токен', () => {
  it('заголовок Bearer', () => {
    expect(presentedToken('Bearer abc123', undefined)).toBe('abc123');
  });

  it('пробелы вокруг значения не считаются его частью', () => {
    expect(presentedToken('Bearer  abc123  ', undefined)).toBe('abc123');
  });

  it('другая схема авторизации токеном не является', () => {
    expect(presentedToken('Basic abc123', undefined)).toBeUndefined();
    expect(presentedToken('bearer abc123', undefined)).toBeUndefined();
    expect(presentedToken('abc123', undefined)).toBeUndefined();
  });

  it('строка запроса читается только там, где маршрут ей доверяет', () => {
    expect(presentedToken(undefined, { token: 'abc123' }, true)).toBe('abc123');
    expect(presentedToken(undefined, { token: '' }, true)).toBeUndefined();
    expect(presentedToken(undefined, { token: 42 }, true)).toBeUndefined();
    expect(presentedToken(undefined, {}, true)).toBeUndefined();
    expect(presentedToken(undefined, undefined, true)).toBeUndefined();
  });

  it('по умолчанию строка запроса не читается вовсе — забытый параметр закрывает, а не открывает', () => {
    expect(presentedToken(undefined, { token: 'abc123' })).toBeUndefined();
    expect(presentedToken(undefined, { token: 'abc123' }, false)).toBeUndefined();
  });

  it('заголовок сильнее строки запроса: адрес попадает в логи, заголовок нет', () => {
    expect(presentedToken('Bearer fromHeader', { token: 'fromQuery' }, true)).toBe('fromHeader');
    // Присланный заголовок решает всё: неверный Bearer не «спасается» верным ?token=.
    expect(presentedToken('Bearer wrong', { token: 'fromQuery' }, true)).toBe('wrong');
  });
});

describe('acceptsQueryToken: где токен принимается строкой запроса', () => {
  it('только поток событий — его браузер открывает адресом (EventSource без заголовков)', () => {
    expect(acceptsQueryToken('GET', '/api/events')).toBe(true);
    expect(acceptsQueryToken('GET', '/api/events?token=abc')).toBe(true);
  });

  it('обычные маршруты — нет, в том числе GET', () => {
    expect(acceptsQueryToken('GET', '/api/system')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/settings?token=abc')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/projects')).toBe(false);
  });

  it('потоки, которые клиенты читают fetch-ом с заголовком, — нет', () => {
    expect(acceptsQueryToken('GET', '/api/chat/abc/stream?from=0')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/provider-chat/chats/abc/stream')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/sandbox/run')).toBe(false);
  });

  it('другой метод или похожий путь — нет', () => {
    expect(acceptsQueryToken('POST', '/api/events')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/events/extra')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/eventsX')).toBe(false);
    expect(acceptsQueryToken('GET', '/api/Events')).toBe(false);
  });
});

describe('isValidApiToken: сравнение', () => {
  const expected = 'S3cr3t-token-value';

  it('совпадение', () => {
    expect(isValidApiToken(expected, expected)).toBe(true);
  });

  it('пусто и не предъявлено — всегда отказ', () => {
    expect(isValidApiToken(undefined, expected)).toBe(false);
    expect(isValidApiToken('', expected)).toBe(false);
  });

  it('префикс не проходит: длина сравнивается до содержимого', () => {
    expect(isValidApiToken(expected.slice(0, -1), expected)).toBe(false);
    expect(isValidApiToken(`${expected}x`, expected)).toBe(false);
  });

  it('один изменённый символ — отказ', () => {
    expect(isValidApiToken(`${expected.slice(0, -1)}X`, expected)).toBe(false);
  });
});
