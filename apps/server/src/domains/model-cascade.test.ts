import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@agentdeck/contracts';
import { cascadeProjectKey, expandAssignedModel, isCascadeEnabled } from './model-cascade.ts';

/**
 * Правило подбора моделей и его проектная область. Проверяем ровно то, из-за
 * чего оно может обмануть человека: выключил в проекте — а дети разделения
 * работают в КОПИЯХ веток, и правило обязано действовать и там.
 */

const PROJECT = 'C:/work/agentdeck';
const COPY = 'C:/work/agentdeck-worktrees/feature-login';

describe('cascadeProjectKey', () => {
  it('копия ветки сводится к самому проекту', () => {
    expect(cascadeProjectKey(COPY)).toBe(cascadeProjectKey(PROJECT));
    expect(cascadeProjectKey('C:/work/agentdeck-worktrees/task/split-2')).toBe(
      cascadeProjectKey(PROJECT),
    );
  });

  it('обычный путь остаётся собой, слэши и хвост нормализуются', () => {
    expect(cascadeProjectKey('C:\\work\\agentdeck\\')).toBe(cascadeProjectKey(PROJECT));
    expect(cascadeProjectKey('')).toBe('');
  });
});

describe('isCascadeEnabled', () => {
  it('умолчание — включено: записи есть только у выключенных проектов', () => {
    expect(isCascadeEnabled([], PROJECT)).toBe(true);
    expect(isCascadeEnabled([[cascadeProjectKey('C:/work/other'), false]], PROJECT)).toBe(true);
  });

  it('выключенное в проекте действует и в подпапке, и в копии ветки', () => {
    const entries: Array<[string, boolean]> = [[cascadeProjectKey(PROJECT), false]];

    expect(isCascadeEnabled(entries, PROJECT)).toBe(false);
    expect(isCascadeEnabled(entries, `${PROJECT}/apps/web`)).toBe(false);
    expect(isCascadeEnabled(entries, COPY)).toBe(false);
  });

  /** Правило, поставленное ближе к работе, точнее — поэтому длиннее выигрывает. */
  it('самое длинное совпадение решает', () => {
    const entries: Array<[string, boolean]> = [
      [cascadeProjectKey('C:/work'), false],
      [cascadeProjectKey(PROJECT), true],
    ];

    expect(isCascadeEnabled(entries, PROJECT)).toBe(true);
    expect(isCascadeEnabled(entries, 'C:/work/another')).toBe(false);
  });
});

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
