import { describe, expect, it } from 'vitest';
import { groundedKnobs } from './knobs.ts';

/**
 * Ответ модели о числах скилла → только обоснованные числа (ревью 28.09,
 * F-332): подпись без текста на обоих языках проходила, и у группы появлялось
 * число без имени.
 */
const SKILL = 'Run exactly **two** review rounds.';
const knob = (label: { ru: string; en: string }) => ({
  key: 'review-rounds',
  label,
  default: 2,
  min: 1,
  max: 4,
  quote: 'Run exactly two review rounds.',
});

describe('groundedKnobs: подпись числа', () => {
  it('с подписью хотя бы на одном языке — берётся', () => {
    const knobs = groundedKnobs('s', { knobs: [knob({ ru: '', en: 'Review rounds' })] }, SKILL);
    expect(knobs.map((item) => item.key)).toEqual(['review-rounds']);
  });

  it('пустая подпись (или одни пробелы) — отброшено', () => {
    expect(groundedKnobs('s', { knobs: [knob({ ru: '', en: '' })] }, SKILL)).toEqual([]);
    expect(groundedKnobs('s', { knobs: [{ ...knob({ ru: ' ', en: '' }) }] }, SKILL)).toEqual([]);
    const { label: _label, ...noLabel } = knob({ ru: '', en: '' });
    expect(groundedKnobs('s', { knobs: [noLabel] }, SKILL)).toEqual([]);
  });
});
