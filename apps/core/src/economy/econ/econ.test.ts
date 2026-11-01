import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_PAIRS, judgeEcon, learnFresh } from './oracle.ts';
import type { EconFixture, ResumeRow } from './oracle.ts';
import { ECON_PRIOR } from './prior.ts';

/**
 * Оракул P14 (G6): правило продолжения (`continuationNumbers`, настоящая функция) против
 * измеренного расхода экономической библиотеки — только числа из локальных транскриптов
 * (`tools/econ-extract.mjs`). Меньше 20 пар — «не доказано», никогда не зелёный.
 */

const FIXTURE = JSON.parse(
  readFileSync(new URL('../__fixtures__/econ/econ.json', import.meta.url), 'utf8'),
) as EconFixture & { sessions: number };

describe('P14 econ oracle: the continuation rule against the measured economics library', () => {
  it('within spread per group and ≥ 80% pair ranking on the held-out rows', () => {
    const got = judgeEcon(FIXTURE);
    expect(got.reasons).toEqual([]);
    expect(got.verdict).toBe('proven');
    expect(got.pairs).toBeGreaterThanOrEqual(MIN_PAIRS);
    expect(got.agreement).toBeGreaterThanOrEqual(0.8);
    // Каждая группа реально судилась (≥ 5 образцов), не прошла молча за пустотой.
    for (const g of got.groups) expect(g.n, g.group).toBeGreaterThanOrEqual(5);
  });

  it('fewer than 20 measured pairs → not proven, never green', () => {
    const small = { resumes: FIXTURE.resumes.slice(0, 4), fresh: FIXTURE.fresh.slice(0, 4) };
    const got = judgeEcon(small);
    expect(got.pairs).toBeLessThan(MIN_PAIRS);
    expect(got.verdict).toBe('not-proven');
  });

  it('a rule that ignores the cache age fails the oracle (the check can go red)', () => {
    // Все возвраты помечены «часовой срок», хотя кэш писался пятиминутным: холодные считаются
    // тёплыми, предсказание в разы ниже измеренного — разброс группы промахивается мимо 1.
    const lying: EconFixture = {
      ...FIXTURE,
      resumes: FIXTURE.resumes.map(([gap, ...rest]) => [gap * 100, ...rest] as ResumeRow),
    };
    expect(judgeEcon(lying).verdict).toBe('failed');
  });

  it('ECON_PRIOR equals the medians of the fixture: a re-extracted fixture without it is red', () => {
    const learned = learnFresh(FIXTURE.fresh);
    expect(learned.orientationTurns).toBe(ECON_PRIOR.orientationTurns);
    expect(Math.round(learned.turnCostRatio * 100) / 100).toBe(ECON_PRIOR.turnCostRatio);
  });
});
