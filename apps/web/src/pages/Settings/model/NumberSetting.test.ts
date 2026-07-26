import { describe, it, expect } from 'vitest';
import { typeNumberSetting, commitNumberSetting } from './NumberSetting';

/**
 * Регрессия: «Ожидание сети» (2000…120000) нельзя было изменить с клавиатуры.
 * Поле подчинялось сохранённому значению, а патч уходил только для числа уже в
 * границах — а любой префикс допустимого числа меньше 2000, поэтому каждое
 * нажатие откатывалось. Соседнее поле «сколько копий хранить» (min 1) по той же
 * причине нельзя было очистить, чтобы набрать заново.
 */

const timeout = { min: 2000, max: 120000 };
const keep = { min: 1, max: 100 };

describe('typeNumberSetting', () => {
  it('промежуточное «5» остаётся в поле, хотя сохранять его рано', () => {
    expect(typeNumberSetting('5', timeout)).toEqual({ text: '5', value: undefined });
  });

  it('число можно донабрать до допустимого, и тогда оно сохраняется', () => {
    expect(typeNumberSetting('50', timeout).value).toBeUndefined();
    expect(typeNumberSetting('500', timeout).value).toBeUndefined();
    expect(typeNumberSetting('5000', timeout)).toEqual({ text: '5000', value: 5000 });
  });

  it('пустое поле не откатывается — его можно очистить и набрать заново', () => {
    expect(typeNumberSetting('', keep)).toEqual({ text: '', value: undefined });
  });

  it('выход за верхнюю границу в поле виден, но не сохраняется', () => {
    expect(typeNumberSetting('999999', timeout)).toEqual({ text: '999999', value: undefined });
  });

  it('дробное не сохраняем: настройка целочисленная', () => {
    expect(typeNumberSetting('2500.5', timeout).value).toBeUndefined();
  });
});

describe('commitNumberSetting', () => {
  it('уход из поля подтягивает недобранное к нижней границе', () => {
    expect(commitNumberSetting('5', timeout, 30000)).toBe(2000);
  });

  it('и обрезает по верхней', () => {
    expect(commitNumberSetting('999999', timeout, 30000)).toBe(120000);
  });

  it('пустое поле возвращает сохранённое, а не ноль', () => {
    expect(commitNumberSetting('', keep, 10)).toBe(10);
    expect(commitNumberSetting('   ', timeout, 30000)).toBe(30000);
  });

  it('мусор тоже возвращает сохранённое', () => {
    expect(commitNumberSetting('abc', timeout, 30000)).toBe(30000);
  });

  it('годное значение остаётся как есть, дробное округляется вниз', () => {
    expect(commitNumberSetting('45000', timeout, 30000)).toBe(45000);
    expect(commitNumberSetting('45000.9', timeout, 30000)).toBe(45000);
  });
});
