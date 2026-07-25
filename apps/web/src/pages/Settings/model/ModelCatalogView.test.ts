import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@claude-control/contracts';
import { formatContext, visibleModels, VISIBLE_MODELS } from './ModelCatalogView';

const models = (count: number): ModelInfo[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`,
    name: `Model ${index}`,
    family: 'f',
    vendor: 'v',
  }));

describe('карточка моделей', () => {
  it('до раскрытия показывает первую дюжину, после — весь список', () => {
    const all = models(30);

    expect(visibleModels(all, false)).toHaveLength(VISIBLE_MODELS);
    expect(visibleModels(all, true)).toHaveLength(30);
    // Коротким спискам раскрытие не нужно.
    expect(visibleModels(models(3), false)).toHaveLength(3);
  });

  it('окно контекста показывается человеческим числом', () => {
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(200_000)).toBe('200K');
    expect(formatContext(1_500_000)).toBe('1.5M');
    expect(formatContext(512)).toBe('512');
  });

  it('неизвестный лимит не превращается в ноль', () => {
    expect(formatContext(undefined)).toBe('');
    expect(formatContext(0)).toBe('');
  });
});
