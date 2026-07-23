import { describe, it, expect } from 'vitest';
import { parseChord, parseStep } from './parseChord';
import { matchSequence, stepsEqual } from './matchSequence';
import { isEditableTarget } from './isEditableTarget';
import type { KeyStep } from './hotkeys.types';

/**
 * Разбор и сопоставление аккордов клавиш. Проверяем грамматику (модификаторы,
 * последовательности) и правило совпадения по хвосту буфера — на этом держатся
 * и `mod+k`, и последовательности вроде `g o`, не мешая одиночным клавишам.
 */

describe('parseStep', () => {
  it('разбирает простую клавишу', () => {
    expect(parseStep('g')).toEqual({ key: 'g', mod: false });
  });

  it('приводит букву к нижнему регистру', () => {
    expect(parseStep('K')).toEqual({ key: 'k', mod: false });
  });

  it('сворачивает ctrl/cmd/meta в общий mod', () => {
    expect(parseStep('mod+k')).toEqual({ key: 'k', mod: true });
    expect(parseStep('ctrl+k')).toEqual({ key: 'k', mod: true });
    expect(parseStep('cmd+k')).toEqual({ key: 'k', mod: true });
    expect(parseStep('meta+k')).toEqual({ key: 'k', mod: true });
  });

  it('терпит пробелы вокруг плюса', () => {
    expect(parseStep(' mod + k ')).toEqual({ key: 'k', mod: true });
  });

  it('шаг без собственной клавиши невалиден', () => {
    expect(parseStep('mod')).toBeNull();
    expect(parseStep('')).toBeNull();
  });

  it('сохраняет символы как есть', () => {
    expect(parseStep('/')).toEqual({ key: '/', mod: false });
    expect(parseStep('?')).toEqual({ key: '?', mod: false });
  });
});

describe('parseChord', () => {
  it('разбирает последовательность из нескольких шагов', () => {
    expect(parseChord('g o')).toEqual([
      { key: 'g', mod: false },
      { key: 'o', mod: false },
    ]);
  });

  it('одиночный аккорд с модификатором — один шаг', () => {
    expect(parseChord('mod+k')).toEqual([{ key: 'k', mod: true }]);
  });

  it('схлопывает лишние пробелы между шагами', () => {
    expect(parseChord('g    o')).toHaveLength(2);
  });

  it('отбрасывает невалидные шаги, сохраняя валидные', () => {
    expect(parseChord('g mod o')).toEqual([
      { key: 'g', mod: false },
      { key: 'o', mod: false },
    ]);
  });
});

describe('stepsEqual', () => {
  it('равны при совпадении клавиши и модификатора', () => {
    expect(stepsEqual({ key: 'k', mod: true }, { key: 'k', mod: true })).toBe(true);
  });

  it('различаются по модификатору', () => {
    expect(stepsEqual({ key: 'k', mod: true }, { key: 'k', mod: false })).toBe(false);
  });
});

describe('matchSequence', () => {
  const step = (key: string, mod = false): KeyStep => ({ key, mod });

  it('совпадает, когда искомое лежит в конце буфера', () => {
    const buffer = [step('x'), step('g'), step('o')];
    expect(matchSequence(buffer, [step('g'), step('o')])).toBe(true);
  });

  it('не совпадает, когда искомое не в конце', () => {
    const buffer = [step('g'), step('o'), step('x')];
    expect(matchSequence(buffer, [step('g'), step('o')])).toBe(false);
  });

  it('совпадает для одиночного шага с модификатором', () => {
    expect(matchSequence([step('a'), step('k', true)], [step('k', true)])).toBe(true);
  });

  it('пустая искомая последовательность не совпадает никогда', () => {
    expect(matchSequence([step('g')], [])).toBe(false);
  });

  it('буфер короче искомого — не совпадает', () => {
    expect(matchSequence([step('o')], [step('g'), step('o')])).toBe(false);
  });

  it('учитывает модификатор при сравнении хвоста', () => {
    // Голое `k` не должно срабатывать как `mod+k`.
    expect(matchSequence([step('k')], [step('k', true)])).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('распознаёт поля ввода по тегу', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
  });

  it('распознаёт contenteditable', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('обычный элемент редактируемым не считается', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});
