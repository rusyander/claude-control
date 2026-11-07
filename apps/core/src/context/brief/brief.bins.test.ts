import { describe, expect, it } from 'vitest';
import { BriefOverBudget, buildBrief } from './brief.ts';
import type { BriefPart } from './brief.types.ts';

/**
 * Корзины частей брифа этапа 11: карта разведки ведущего (`recon-map`) — своя корзина `recon`
 * (3000 байт), отрывок прошлой неудачной попытки (`previous-attempt`) — корзина состояния единицы
 * (`unit-state`, 3000 байт). Часть без корзины бюджет не судил бы вовсе — сколь угодно длинная
 * карта ушла бы модели. Вид шага без итога: судится только корзина.
 */

const KIND_WITHOUT_TOTAL = 'no-total-kind';
const part = (id: BriefPart['id'], text: string): BriefPart => ({ id, text, from: 'test' });

function overOf(run: () => unknown): BriefOverBudget {
  try {
    run();
  } catch (error) {
    if (error instanceof BriefOverBudget) return error;
    throw error;
  }
  throw new Error('expected BriefOverBudget, the brief was built');
}

describe('brief bins of stage 11 parts', () => {
  it('a recon map over 3000 bytes breaks the recon bin', () => {
    const over = overOf(() =>
      buildBrief([part('recon-map', 'm'.repeat(3100))], KIND_WITHOUT_TOTAL),
    );
    expect(over.breaches).toEqual([
      expect.objectContaining({ part: 'recon-map', bin: 'recon', budget: 3000 }),
    ]);
  });

  it('a previous-attempt excerpt over 3000 bytes breaks the unit-state bin', () => {
    const over = overOf(() =>
      buildBrief([part('previous-attempt', 'p'.repeat(3100))], KIND_WITHOUT_TOTAL),
    );
    expect(over.breaches).toEqual([
      expect.objectContaining({ part: 'previous-attempt', bin: 'unit-state', budget: 3000 }),
    ]);
  });

  it('within the bins both parts are placed', () => {
    const got = buildBrief(
      [part('recon-map', 'map'), part('previous-attempt', 'failed: x')],
      KIND_WITHOUT_TOTAL,
    );
    expect(got.placed.map((p) => p.id).sort()).toEqual(['previous-attempt', 'recon-map']);
  });
});
