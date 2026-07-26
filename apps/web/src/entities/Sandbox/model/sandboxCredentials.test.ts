import { describe, it, expect } from 'vitest';
import { sandboxAccessNotice } from './sandboxCredentials';

/**
 * Регрессия: сервер считал источник доступа и причину его отсутствия, но до
 * экрана они не доходили — человек отправлял запрос и получал сырое
 * «Not logged in» из недр CLI. Проверяем правило показа и главное ограничение:
 * наружу идёт ИСТОЧНИК, а не содержимое доступа.
 */

/** Перевод-заглушка: ключ виден в результате, подстановки не нужны. */
const t = (key: string): string => `<${key}>`;

describe('sandboxAccessNotice', () => {
  it('называет источник, когда доступ найден', () => {
    expect(sandboxAccessNotice({ source: 'file' }, t)).toEqual({
      sourceText: '<sandbox.access_file>',
    });
    expect(sandboxAccessNotice({ source: 'keychain' }, t)?.sourceText).toBe(
      '<sandbox.access_keychain>',
    );
    expect(sandboxAccessNotice({ source: 'apiKey' }, t)?.sourceText).toBe(
      '<sandbox.access_apiKey>',
    );
  });

  it('при найденном доступе не предупреждает ни о чём', () => {
    expect(sandboxAccessNotice({ source: 'panel' }, t)?.warning).toBeUndefined();
  });

  it('без доступа предупреждает и сохраняет причину сервера', () => {
    const notice = sandboxAccessNotice(
      { source: 'none', reason: 'Файл /home/u/.claude/.credentials.json не читается.' },
      t,
    );

    expect(notice?.sourceText).toBe('<sandbox.access_none>');
    // Причина конкретна (называет путь) — она внутри общего объяснения.
    expect(notice?.warning).toContain('<sandbox.noAccess>');
    expect(notice?.warning).toContain('/home/u/.claude/.credentials.json');
  });

  it('без доступа и без причины предупреждает общим текстом', () => {
    expect(sandboxAccessNotice({ source: 'none' }, t)?.warning).toBe('<sandbox.noAccess>');
  });

  it('пока песочница собирается — молчит', () => {
    // Ответа сервера ещё нет: выдумывать состояние доступа нельзя.
    expect(sandboxAccessNotice(undefined, t)).toBeUndefined();
  });

  it('в тексте нет ничего, кроме источника и причины', () => {
    // Внутри песочницы лежит КОПИЯ доступа к аккаунту: значение токена не
    // должно попасть на экран ни при каком источнике.
    const notice = sandboxAccessNotice({ source: 'none', reason: 'нет файла' }, t);
    expect(Object.keys(notice ?? {}).sort()).toEqual(['sourceText', 'warning']);
  });
});
