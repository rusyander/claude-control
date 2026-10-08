import { describe, expect, it } from 'vitest';
import { langAfterKey } from './langAfterKey';

describe('клавиши на вкладках языка шага (F-275)', () => {
  it('Home и End ведут к краям списка, а не переключают сторону', () => {
    expect(langAfterKey('Home', 'ru')).toBe('ru');
    expect(langAfterKey('Home', 'en')).toBe('ru');
    expect(langAfterKey('End', 'en')).toBe('en');
    expect(langAfterKey('End', 'ru')).toBe('en');
  });

  it('стрелки переключают на другую сторону', () => {
    expect(langAfterKey('ArrowRight', 'ru')).toBe('en');
    expect(langAfterKey('ArrowLeft', 'en')).toBe('ru');
  });

  it('прочие клавиши вкладку не трогают', () => {
    expect(langAfterKey('Enter', 'ru')).toBeUndefined();
  });
});
