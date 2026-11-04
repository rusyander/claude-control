import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@agentdeck/contracts';
import { expandAssignedModel } from './model-cascade.ts';

/**
 * Разворот алиаса в свежую модель семейства. Проверяем то, из-за чего функция
 * и появилась: живой CLI на `sonnet` уходил в `claude-sonnet-4-6`, хотя каталог
 * знает Sonnet 5, — понижение ранга не должно быть понижением поколения.
 */
function model(id: string, family: string, releaseDate: string): ModelInfo {
  return { id, name: id, family, vendor: 'anthropic', releaseDate };
}

const CATALOG: ModelInfo[] = [
  model('claude-sonnet-4-6', 'claude-sonnet', '2026-02-17'),
  model('claude-sonnet-5', 'claude-sonnet', '2026-06-29'),
  model('claude-opus-4-8', 'claude-opus', '2026-05-28'),
  model('claude-opus-5', 'claude-opus', '2026-07-24'),
];

describe('expandAssignedModel', () => {
  it('алиас разворачивается в самую свежую модель семейства', () => {
    expect(expandAssignedModel(CATALOG, 'sonnet')).toBe('claude-sonnet-5');
    expect(expandAssignedModel(CATALOG, 'opus')).toBe('claude-opus-5');
  });

  it('конкретное имя не трогаем: это выбор человека, а не наш подбор', () => {
    expect(expandAssignedModel(CATALOG, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(expandAssignedModel(CATALOG, 'claude-opus-4-5-20251101')).toBe(
      'claude-opus-4-5-20251101',
    );
  });

  it('семейства в каталоге нет — оставляем алиас: прогон с ним заведомо пойдёт', () => {
    expect(expandAssignedModel(CATALOG, 'haiku')).toBe('haiku');
    expect(expandAssignedModel([], 'sonnet')).toBe('sonnet');
  });

  it('пустое значение значит «как решит CLI» и остаётся пустым', () => {
    expect(expandAssignedModel(CATALOG, '')).toBe('');
  });
});
