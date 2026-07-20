import { describe, it, expect } from 'vitest';
import { looksLikePermission } from './looksLikePermission';

/**
 * Мягкая проверка формы правила доступа. Она не блокирует сохранение, но
 * подсказывает об опечатке — поэтому её набор допустимых форм должен совпадать с
 * тем, что реально разбирает сервер (`permissions.ts`), иначе валидное правило
 * получало бы ложное предупреждение.
 *
 * Ключевая регрессия: имя MCP-сервера может содержать одиночное подчёркивание
 * (`mcp__my_server__tool`) — разделитель сервер↔инструмент это двойное `__`.
 * Прежняя клиентская регулярка запрещала `_` в имени сервера и ошибочно ругалась
 * на имена, которые сервер парсит верно (см. permissions.test.ts).
 */
describe('looksLikePermission', () => {
  it('пустой шаблон не считается ошибкой (ещё ничего не ввели)', () => {
    expect(looksLikePermission('')).toBe(true);
    expect(looksLikePermission('   ')).toBe(true);
  });

  it('имя инструмента целиком', () => {
    expect(looksLikePermission('Bash')).toBe(true);
    expect(looksLikePermission('Read')).toBe(true);
    expect(looksLikePermission('WebFetch')).toBe(true);
  });

  it('имя с уточнением в скобках', () => {
    expect(looksLikePermission('Bash(git push:*)')).toBe(true);
    expect(looksLikePermission('Read(~/**)')).toBe(true);
    expect(looksLikePermission('Write(src/**)')).toBe(true);
  });

  it('MCP-инструмент с обычным именем сервера', () => {
    expect(looksLikePermission('mcp__gitlab-gorgona__get_project')).toBe(true);
  });

  it('имя MCP-сервера с одиночным подчёркиванием — не предупреждение', () => {
    // Регрессия: сервер такое имя парсит корректно (permissions.test.ts:
    // «имя MCP-сервера с одиночным подчёркиванием разбирается верно»).
    expect(looksLikePermission('mcp__my_server__do_thing')).toBe(true);
  });

  it('весь MCP-сервер без инструмента', () => {
    expect(looksLikePermission('mcp__gitlab-gorgona')).toBe(true);
    expect(looksLikePermission('mcp__my_server')).toBe(true);
  });

  it('явно непохожее на правило подсвечивается', () => {
    expect(looksLikePermission('это не правило')).toBe(false);
    expect(looksLikePermission('mcp__')).toBe(false);
    expect(looksLikePermission('123abc')).toBe(false);
  });
});
