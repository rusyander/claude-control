import { describe, it, expect } from 'vitest';
import type { ProviderCheckResult } from '@claude-control/contracts';
import { trustBadge, checkScore, stepTone } from './trust';

function result(level: ProviderCheckResult['level']): ProviderCheckResult {
  return {
    provider: 'codex',
    providerName: 'Codex',
    at: '2026-07-25T10:00:00.000Z',
    level,
    steps: [
      { id: 'cli', status: 'pass', detail: '' },
      { id: 'mcp', status: 'pass', detail: '' },
      { id: 'permissions', status: 'skipped', detail: '' },
      { id: 'assistant', status: 'warn', detail: '' },
    ],
  };
}

describe('trustBadge', () => {
  it('без проверки показывает объявленный статус', () => {
    expect(trustBadge('experimental', undefined).key).toBe('settings.providerExperimental');
    expect(trustBadge('verified', undefined).key).toBe('settings.providerVerified');
  });

  it('проверка на этой машине вытесняет объявленный статус', () => {
    expect(trustBadge('experimental', result('verified')).key).toBe('providerCheck.badge.verified');
    // В обе стороны: провал перебивает даже заявленный `verified`.
    expect(trustBadge('verified', result('failed')).tone).toBe('danger');
  });
});

describe('checkScore', () => {
  it('пропущенные шаги не считаются ни в успехи, ни в общее число', () => {
    expect(checkScore(result('partial'))).toEqual({ passed: 2, total: 3 });
  });
});

describe('stepTone', () => {
  it('каждому итогу свой цвет, пропуск — нейтральный', () => {
    expect(stepTone('pass')).toBe('success');
    expect(stepTone('warn')).toBe('warning');
    expect(stepTone('fail')).toBe('danger');
    expect(stepTone('skipped')).toBe('neutral');
  });
});
