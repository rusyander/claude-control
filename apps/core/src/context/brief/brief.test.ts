import { describe, expect, it } from 'vitest';
import { BIN_BUDGET, BriefOverBudget, buildBrief, KIND_TOTAL } from './brief.ts';
import type { BriefPart } from './brief.types.ts';
import { kindParts, P13_KINDS } from '../__fixtures__/kind-parts.ts';

/**
 * Бриф шага (03 §Context, R:S2-28, P13): постоянный порядок частей, маска секретов до модели (хеш
 * коммита остаётся), сверх бюджета корзины или итога вида — отказ сборки `BriefOverBudget`, никакого
 * среза; снимок брифа по виду шага.
 */

const part = (id: BriefPart['id'], text: string, from = 'test'): BriefPart => ({ id, text, from });

/** Ловит отказ сборки: тест судит его поля, а не текст сообщения. */
function overOf(run: () => unknown): BriefOverBudget {
  try {
    run();
  } catch (error) {
    if (error instanceof BriefOverBudget) return error;
    throw error;
  }
  throw new Error('expected BriefOverBudget, the brief was built');
}

describe('buildBrief', () => {
  it('orders parts by the section list whatever the input order; empty parts dropped', () => {
    const got = buildBrief(
      [
        part('knowledge', 'skill x'),
        part('step', 'do it'),
        part('human-message', 'please'),
        part('task', 'T'),
        part('profile', '  '),
      ],
      'work',
    );
    expect(got.placed.map((p) => p.id)).toEqual(['task', 'step', 'human-message', 'knowledge']);
    expect(got.text).toBe(
      '## task\nT\n\n## step\ndo it\n\n## human-message\nplease\n\n## knowledge\nskill x',
    );
    expect(got.total).toBe(10_000);
    expect(got.placed.every((p) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true);
  });

  it('two parts with one id become one section: the sent-set keys by id, so they never overwrite', () => {
    const got = buildBrief(
      [part('profile', 'repo a moved', 'w'), part('profile', 'repo b moved', 'w')],
      'work',
    );
    expect(got.placed).toHaveLength(1);
    expect(got.text).toBe('## profile\nrepo a moved\n\nrepo b moved');
  });

  it('secrets are masked before the model sees them; a bare commit hash stays', () => {
    const key = `sk-ant-${'a'.repeat(30)}`;
    const sha = 'a'.repeat(40);
    const got = buildBrief([part('handoff', `token ${key} at commit ${sha}`)], 'fix');
    expect(got.text).not.toContain(key);
    expect(got.text).toContain(sha);
    expect(got.masked).toBe(1);
    expect(got.placed[0]?.masked).toBe(1);
  });

  it('a known secret value (session env) is masked by value even when its shape is unknown', () => {
    const got = buildBrief([part('handoff', 'login with hunter2-pass please')], 'fix', [
      'hunter2-pass',
    ]);
    expect(got.text).not.toContain('hunter2-pass');
    expect(got.masked).toBe(1);
  });

  it('over its bin budget the build fails naming the bin and the part — nothing is cut', () => {
    const big = 'я'.repeat(2000); // 4000 bytes
    const err = overOf(() =>
      buildBrief([part('handoff', 'short'), part('findings', big, 'conductor/review')], 'review'),
    );
    expect(err.code).toBe('brief-over-budget');
    expect(err.stepKind).toBe('review');
    expect(err.breaches).toEqual([
      {
        part: 'findings',
        from: 'conductor/review',
        bin: 'unit-state',
        bytes: expect.any(Number),
        budget: BIN_BUDGET['unit-state'],
      },
    ]);
    expect(err.breaches[0]!.bytes).toBeGreaterThan(BIN_BUDGET['unit-state']);
    expect(err.message).toMatch(/findings \(conductor\/review\) fills the unit-state bin/);
    // Одна часть, одна корзина: срез «до бюджета» собрал бы бриф — сборка обязана упасть.
    const alone = overOf(() =>
      buildBrief([part('step', 'z'.repeat(BIN_BUDGET.step + 500))], 'work'),
    );
    expect(alone.breaches.map((b) => b.bin)).toEqual(['step']);
  });

  it('exactly at the bin budget builds; one byte more fails', () => {
    // Заголовок `## step\n` (8 байт) входит в корзину.
    const fit = 'x'.repeat(BIN_BUDGET.step - 8);
    expect(buildBrief([part('step', fit)], 'work').bytes).toBe(BIN_BUDGET.step);
    expect(overOf(() => buildBrief([part('step', `${fit}x`)], 'work')).breaches[0]?.bin).toBe(
      'step',
    );
  });

  it('the human text is never limited and does not count toward the kind total', () => {
    const words = 'x'.repeat(15_000);
    const got = buildBrief([part('human-message', words)], 'fix');
    expect(got.bytes).toBe(0);
    expect(got.text).toContain(words);
  });

  it('kind total: fix 6k exceeded by full bins fails as total; a kind without a total builds', () => {
    const full = (id: BriefPart['id'], n: number) => part(id, 'x'.repeat(n));
    // Заголовок `## <id>\n` входит в корзину — части чуть меньше бюджета, чтобы корзины прошли.
    const parts = [full('step', 1900), full('requirements', 1900), full('handoff', 2900)];
    const err = overOf(() => buildBrief(parts, 'fix'));
    expect(err.breaches).toEqual([
      { part: null, from: null, bin: 'total', bytes: expect.any(Number), budget: 6000 },
    ]);
    expect(buildBrief(parts, 'intake').total).toBeNull();
    expect(buildBrief(parts, 'work').bytes).toBeLessThanOrEqual(KIND_TOTAL.work!);
  });
});

/** Снимок брифа по виду шага (P13): набор секций каждого вида из портов ядра + части зон. */
describe('brief snapshot per step kind (P13)', () => {
  for (const kind of P13_KINDS)
    it(`${kind}: sections, bytes and total`, () => {
      const got = buildBrief(kindParts(kind), kind);
      expect(got.bytes).toBeLessThanOrEqual(KIND_TOTAL[kind]!);
      expect({
        kind,
        total: got.total,
        bytes: got.bytes,
        sections: got.placed.map((p) => `${p.id}:${p.bytes}`),
      }).toMatchSnapshot();
    });
});
