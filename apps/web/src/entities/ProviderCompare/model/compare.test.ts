import { describe, it, expect } from 'vitest';
import type { CompareSectionResult } from '@claude-control/contracts';
import { selectableKeys, stateTone } from './compare';

/**
 * Правило отбора записей к переносу. Проверяем именно его, а не разметку:
 * ошибка здесь означала бы предложение записать в чужой конфиг то, что панель
 * переносить не умеет.
 */
const section = (over: Partial<CompareSectionResult> = {}): CompareSectionResult => ({
  section: 'mcp',
  left: { providerId: 'claude', providerName: 'Claude Code', supported: true },
  right: { providerId: 'codex', providerName: 'Codex', supported: true },
  comparable: true,
  migratable: true,
  entries: [
    { key: 'both', left: 'a', right: 'a', state: 'same', opaque: false },
    { key: 'onlyLeft', left: 'a', state: 'left-only', opaque: false },
    { key: 'onlyRight', right: 'b', state: 'right-only', opaque: false },
    { key: 'blocked', left: 'a', state: 'left-only', opaque: false, blocked: 'нельзя' },
  ],
  ...over,
});

describe('selectableKeys', () => {
  it('слева направо берутся записи, которые есть слева и не заблокированы', () => {
    expect(selectableKeys(section(), 'left-to-right')).toEqual(['both', 'onlyLeft']);
  });

  it('справа налево — зеркально', () => {
    expect(selectableKeys(section(), 'right-to-left')).toEqual(['both', 'onlyRight']);
  });

  it('непереносимый раздел не даёт выбрать ничего', () => {
    expect(selectableKeys(section({ migratable: false }), 'left-to-right')).toEqual([]);
  });

  it('совпадение спокойное, расхождение заметное', () => {
    expect(stateTone('same')).toBe('success');
    expect(stateTone('differs')).toBe('warning');
    expect(stateTone('left-only')).toBe('info');
  });
});
