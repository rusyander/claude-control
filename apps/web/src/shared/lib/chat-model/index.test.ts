import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@claude-control/contracts';
import {
  modelLabel,
  MODEL_OPTIONS,
  EFFORT_LEVELS,
  modelSelectOptions,
  withCurrentValue,
} from './index';

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

describe('список выбора модели', () => {
  const model = (id: string, name: string): ModelInfo => ({
    id,
    name,
    family: 'claude-opus',
    vendor: 'anthropic',
  });

  const options = (models: ModelInfo[]): Array<{ value: string; label: string }> =>
    modelSelectOptions(models, MODEL_OPTIONS, (value) => value || 'как выберет CLI');

  it('алиасы идут первыми, конкретные модели — следом и подписаны id', () => {
    const result = options([model('claude-opus-5', 'Claude Opus 5')]);

    expect(result.slice(0, 2)).toEqual([
      { value: '', label: 'как выберет CLI' },
      { value: 'opus', label: 'opus' },
    ]);
    expect(result.at(-1)).toEqual({
      value: 'claude-opus-5',
      label: 'Claude Opus 5 · claude-opus-5',
    });
  });

  it('модель, совпавшая с алиасом, не задваивается', () => {
    const result = options([model('opus', 'Opus')]);

    expect(result.filter((option) => option.value === 'opus')).toHaveLength(1);
  });

  it('выбранная модель остаётся в списке, даже когда каталог не скачался', () => {
    const withPinned = withCurrentValue(options([]), 'claude-opus-4-8');

    expect(withPinned.at(-1)).toEqual({ value: 'claude-opus-4-8', label: 'claude-opus-4-8' });
    // Уже присутствующее значение не дублируется, пустое не добавляется.
    expect(withCurrentValue(options([]), 'opus')).toHaveLength(MODEL_OPTIONS.length);
    expect(withCurrentValue(options([]), '')).toHaveLength(MODEL_OPTIONS.length);
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
