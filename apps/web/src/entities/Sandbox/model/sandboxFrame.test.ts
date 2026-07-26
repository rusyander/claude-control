import { describe, it, expect } from 'vitest';
import { parseSandboxFrame } from './sandboxFrame';

/**
 * Регрессия: разбор кадра стоял в цикле чтения голым `JSON.parse`. Один битый
 * кадр выбрасывал исключение из цикла, прогон обрывался, а вместо ответа агента
 * человек получал «Unexpected end of JSON input». Кадр должен пропускаться.
 */
describe('parseSandboxFrame', () => {
  it('разбирает обычное событие', () => {
    expect(parseSandboxFrame('data: {"kind":"text","text":"привет"}')).toEqual({
      kind: 'text',
      text: 'привет',
    });
  });

  it('находит data: среди служебных строк кадра', () => {
    expect(
      parseSandboxFrame('event: message\nid: 7\ndata: {"kind":"done","costUsd":0.01}'),
    ).toEqual({ kind: 'done', costUsd: 0.01 });
  });

  it('битый JSON пропускает, а не роняет цикл', () => {
    const broken = 'data: {"kind":"text","text":';
    // Прежний код звал JSON.parse напрямую — вот что происходило:
    expect(() => JSON.parse(broken.slice(5))).toThrow();
    expect(parseSandboxFrame(broken)).toBeUndefined();
  });

  it('кадр без data: (пинг-комментарий) — не событие', () => {
    expect(parseSandboxFrame(': keep-alive')).toBeUndefined();
    expect(parseSandboxFrame('')).toBeUndefined();
  });

  it('не объект в кадре событием не считается', () => {
    expect(parseSandboxFrame('data: "готово"')).toBeUndefined();
    expect(parseSandboxFrame('data: null')).toBeUndefined();
  });
});
