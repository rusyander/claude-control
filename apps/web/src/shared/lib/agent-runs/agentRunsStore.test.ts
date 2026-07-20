import { describe, it, expect } from 'vitest';
import { parseSseFrame } from './agentRunsStore';

/**
 * Разбор одного SSE-фрейма (`parseSseFrame`). Ключевое (по аудиту B6): битый
 * data-фрейм не должен ронять цикл чтения потока — неразборный JSON и
 * пинг-комментарий возвращают `undefined`, а не бросают исключение. Валидный
 * фрейм разбирается в событие с `kind` и (если есть) `seq`.
 */
describe('parseSseFrame — разбор SSE-фрейма', () => {
  it('валидный data-фрейм → объект события с kind и seq', () => {
    expect(parseSseFrame('data: {"kind":"text","text":"привет","seq":7}')).toEqual({
      kind: 'text',
      text: 'привет',
      seq: 7,
    });
  });

  it('фрейм без seq → объект без seq (не падает)', () => {
    expect(parseSseFrame('data: {"kind":"gone"}')).toEqual({ kind: 'gone' });
  });

  it('пинг-комментарий (нет строки data:) → undefined', () => {
    expect(parseSseFrame(': ping')).toBeUndefined();
  });

  it('битый JSON в data-фрейме → undefined, а не исключение', () => {
    // Обрезанный/повреждённый кадр не должен ронять цикл чтения потока.
    expect(() => parseSseFrame('data: {"kind":"text", "oops')).not.toThrow();
    expect(parseSseFrame('data: {"kind":"text", "oops')).toBeUndefined();
    expect(parseSseFrame('data: не-json вовсе')).toBeUndefined();
  });

  it('среди строк фрейма берётся именно data:, лишние строки не мешают', () => {
    const part = 'event: message\ndata: {"kind":"done","seq":3}';
    expect(parseSseFrame(part)).toEqual({ kind: 'done', seq: 3 });
  });

  it('поток пинг → битый → валидный: пропускает первые два, разбирает третий', () => {
    // Модель того, как pumpStream обходит фреймы: битый посередине не мешает
    // разобрать следующий валидный.
    expect(parseSseFrame(': ping')).toBeUndefined();
    expect(parseSseFrame('data: {битый')).toBeUndefined();
    expect(parseSseFrame('data: {"kind":"text","text":"ок"}')).toEqual({
      kind: 'text',
      text: 'ок',
    });
  });
});
