import { describe, expect, it } from 'vitest';
import { dataMaskDecision } from './data-mask.ts';
import { foreignTail, redactSecrets } from './redact.ts';
import { rulesHashOf } from './rules-hash.ts';
import { builtinRuleSet } from './default-rules.ts';

/**
 * Чистые части, переехавшие из панели в пакет (план ядра §5 H): панель держит фасады, хост
 * звеньев ядра — прямой импорт. Значения ключей собраны из кусков: в репозитории их нет.
 */
const j = (...parts: string[]): string => parts.join('');

describe('redact — чужой текст без ключей', () => {
  it('свой ключ уходит по значению, чужой — по форме', () => {
    const own = j('own-', 'secret-value');
    const text = `boom ${own} Bearer ${j('abcdefgh', '1234')} ${j('sk-', 'abcdefgh123')}`;
    const safe = redactSecrets(text, own);
    expect(safe).not.toContain(own);
    expect(safe).not.toContain('abcdefgh1234');
    expect(safe).not.toContain('sk-abcdefgh123');
  });

  it('хвост сначала чистится, потом режется', () => {
    expect(foreignTail(`  ${'x'.repeat(10)}  `, undefined, 4)).toBe('xxxx');
  });
});

describe('dataMaskDecision — одно решение для шлюза ядра и звена', () => {
  it('общий выключатель сильнее выбора «нет» на контуре', () => {
    expect(dataMaskDecision({ globalOn: true, choice: false, declared: false })).toEqual({
      on: true,
      reason: 'global',
    });
  });

  it('без выбора решает манифест, выбор «нет» называется выбором', () => {
    expect(dataMaskDecision({ globalOn: false, choice: undefined, declared: true }).reason).toBe(
      'declared',
    );
    expect(dataMaskDecision({ globalOn: false, choice: false, declared: true })).toEqual({
      on: false,
      reason: 'chosen',
    });
  });
});

describe('rulesHashOf — отпечаток набора правил', () => {
  it('тот же набор — тот же хэш, изменённый — другой', () => {
    const rules = builtinRuleSet();
    expect(rulesHashOf(rules)).toBe(rulesHashOf(structuredClone(rules)));
    const changed = rules.map((rule, index) =>
      index === 0 ? { ...rule, enabled: !rule.enabled } : rule,
    );
    expect(rulesHashOf(changed)).not.toBe(rulesHashOf(rules));
  });
});
