import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACT_MS, firstDelay, hasActs, pickAct, type MascotAct } from './mascot-acts';
import { MASCOT_MOODS } from './mascot.constants';

/** Последовательность «случайных» чисел по кругу. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

describe('pickAct', () => {
  it('flash moods have no acts — their motion is the mood itself', () => {
    expect(hasActs('happy')).toBe(false);
    expect(hasActs('dizzy')).toBe(false);
    expect(pickAct('happy')).toBeNull();
    expect(firstDelay('dizzy')).toBe(0);
  });

  it('every long-lived mood has acts', () => {
    const lasting = MASCOT_MOODS.filter((mood) => mood !== 'happy' && mood !== 'dizzy');
    expect(lasting.filter((mood) => !hasActs(mood))).toEqual([]);
  });

  it('roll walks the weights: idle 0 → blink, near 1 → wave (the rare one, last)', () => {
    expect(pickAct('idle', sequence(0, 0))?.act).toBe('blink');
    expect(pickAct('idle', sequence(0.999, 0))?.act).toBe('wave');
    // blink 5 of 11.5: a roll just past it lands on blink2.
    expect(pickAct('idle', sequence(5.01 / 11.5, 0))?.act).toBe('blink2');
  });

  it('gap stays inside the mood range and follows the second roll', () => {
    expect(pickAct('idle', sequence(0, 0))?.gap).toBe(2_200);
    expect(pickAct('idle', sequence(0, 1))?.gap).toBe(5_500);
    expect(pickAct('working', sequence(0, 0.5))?.gap).toBe(1_400);
  });

  it('first act: fixed where the mood must show at once, else a regular gap', () => {
    expect(firstDelay('waving')).toBe(0);
    expect(firstDelay('waiting')).toBe(0);
    expect(firstDelay('lost')).toBe(300);
    expect(firstDelay('idle', () => 0)).toBe(2_200);
  });
});

describe('acts ↔ styles', () => {
  const scss = readFileSync(new URL('./mascot.module.scss', import.meta.url), 'utf8');

  it('every act has a style rule keyed by data-act', () => {
    const missing = (Object.keys(ACT_MS) as MascotAct[]).filter(
      (act) => !scss.includes(`[data-act='${act}']`),
    );
    expect(missing).toEqual([]);
  });
});
