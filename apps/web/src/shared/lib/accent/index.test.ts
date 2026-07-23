import { describe, it, expect } from 'vitest';
import { accentSchema } from '@claude-control/contracts';
import { ACCENT_OPTIONS, accentLabelKey } from './index';

/**
 * Список пресетов акцента для настроек. Он строится из контрактной схемы,
 * поэтому здесь сторожим главное: список покрывает ровно все значения enum
 * (ни один пресет не потеряется в UI и не появится лишний), `default` — первый,
 * а ключ перевода собирается предсказуемо.
 */
describe('ACCENT_OPTIONS', () => {
  it('покрывает ровно все значения accentSchema', () => {
    expect([...ACCENT_OPTIONS].sort()).toEqual([...accentSchema.options].sort());
  });

  it('первый пресет — базовый default', () => {
    expect(ACCENT_OPTIONS[0]).toBe('default');
  });

  it('каждый пресет валиден по схеме', () => {
    for (const accent of ACCENT_OPTIONS) {
      expect(accentSchema.safeParse(accent).success).toBe(true);
    }
  });
});

describe('accentLabelKey', () => {
  it('собирает ключ перевода из имени пресета', () => {
    expect(accentLabelKey('blue')).toBe('settings.accent_blue');
    expect(accentLabelKey('default')).toBe('settings.accent_default');
  });
});
