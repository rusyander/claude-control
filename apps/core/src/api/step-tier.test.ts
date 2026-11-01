import { STEP_KINDS, STEP_TIER_OF } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { PRESETS, presetStep } from '../conductor/scenario/presets.ts';

/**
 * Уровень модели шага по его виду — один на ядро и панель (этап 9): редактор сценария ставит
 * новому шагу `STEP_TIER_OF` контрактов, пресеты ядра читают ту же таблицу, своей копии у них нет.
 * Своя таблица, константа или правка уровня в одном пресете снова развели бы их: шаг из
 * редактора стоил бы иначе, чем тот же шаг пресета, и никто бы этого не увидел.
 */
describe('step tier by kind — contracts and core presets agree', () => {
  it.each(STEP_KINDS)('%s: a preset step gets the contracts tier', (kind) => {
    expect(presetStep('s', kind, 't', []).model.tier).toBe(STEP_TIER_OF[kind]);
  });

  it('every step of every shipped preset carries the contracts tier of its kind', () => {
    const off = PRESETS.flatMap((p) =>
      p.steps
        .filter((s) => s.model.tier !== STEP_TIER_OF[s.kind])
        .map((s) => `${p.id}@${p.version} ${s.id}: ${s.model.tier}`),
    );
    expect(off).toEqual([]);
    // Таблица не вырождена: иначе совпадение с ней ничего не различало бы.
    expect(new Set(PRESETS.flatMap((p) => p.steps.map((s) => s.model.tier))).size).toBe(3);
  });
});
