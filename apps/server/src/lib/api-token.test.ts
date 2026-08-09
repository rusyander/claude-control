import { describe, it, expect } from 'vitest';
import { isValidApiToken, presentedToken } from './api-token.ts';

/**
 * Токен доступа. Чтение и ротация трогают `~/.claude-control` — настоящий
 * каталог пользователя, поэтому здесь проверяется то, что от файла не зависит:
 * КАК токен извлекается из запроса и КАК сравнивается. Ошибка ровно здесь и
 * означала бы дыру: принятый пустой токен, принятый префикс, принятый чужой.
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

  it('строка запроса — запасной путь для потоков', () => {
    expect(presentedToken(undefined, { token: 'abc123' })).toBe('abc123');
    expect(presentedToken(undefined, { token: '' })).toBeUndefined();
    expect(presentedToken(undefined, { token: 42 })).toBeUndefined();
    expect(presentedToken(undefined, {})).toBeUndefined();
    expect(presentedToken(undefined, undefined)).toBeUndefined();
  });

  it('заголовок сильнее строки запроса: адрес попадает в логи, заголовок нет', () => {
    expect(presentedToken('Bearer fromHeader', { token: 'fromQuery' })).toBe('fromHeader');
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
