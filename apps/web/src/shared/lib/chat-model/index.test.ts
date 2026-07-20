import { describe, it, expect } from 'vitest';
import { modelLabel, MODEL_OPTIONS, EFFORT_LEVELS } from './index';

/**
 * Константы и подпись выбора модели/глубины продумывания. Мелочь, но подпись
 * рисуется в шапке чата, а пустое значение («по умолчанию») не должно
 * превращаться в «U» или падать.
 */
describe('modelLabel', () => {
  it('делает первую букву заглавной', () => {
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('sonnet')).toBe('Sonnet');
    expect(modelLabel('haiku')).toBe('Haiku');
  });

  it('пустая строка (по умолчанию) остаётся пустой', () => {
    expect(modelLabel('')).toBe('');
  });
});

describe('константы выбора', () => {
  it('первый вариант модели — пустой (как выберет Claude)', () => {
    expect(MODEL_OPTIONS[0]).toBe('');
    expect(MODEL_OPTIONS).toContain('opus');
  });

  it('первый уровень effort — пустой (по умолчанию)', () => {
    expect(EFFORT_LEVELS[0]).toBe('');
    expect(EFFORT_LEVELS).toContain('max');
  });
});
