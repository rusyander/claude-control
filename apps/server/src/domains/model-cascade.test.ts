import { describe, it, expect } from 'vitest';
import { cascadeProjectKey, isCascadeEnabled } from './model-cascade.ts';

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
