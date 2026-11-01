import type { Confirmation, RequirementClaim } from '@agentdeck/contracts/core/model-tools';
import { describe, expect, it } from 'vitest';
import { decideRequirements } from './decide.ts';
import type { ClaimRow, RequirementsInput } from './requirements.types.ts';

/**
 * Судья требований (02:57, P01) — таблицей по типизированным строкам: «покрыто» только со свежими
 * записями, n/a и «выполнено словами» — только подтверждением ревью, `waived` — только человеком,
 * шаг-вывод обнуляет до ревью (P16), ворота закрыты без полной сверки извлечения позже него (P93).
 */

const A = '01920000-0000-7000-8000-00000000a001';
const B = '01920000-0000-7000-8000-00000000a002';
const PLAN = '01920000-0000-7000-8000-00000000c001';
const WORK = '01920000-0000-7000-8000-00000000c002';
const REVIEW = '01920000-0000-7000-8000-00000000c003';

function base(over: Partial<RequirementsInput> = {}): RequirementsInput {
  return {
    requirements: [
      { id: A, ordinal: 1, text: 'a', source: 'ticket', stepId: PLAN, seq: 10 },
      { id: B, ordinal: 2, text: 'b', source: 'ticket', stepId: PLAN, seq: 11 },
    ],
    waivers: [],
    claims: [],
    derived: [],
    reviews: [{ stepId: REVIEW, complete: true, added: [], seq: 12 }],
    evidence: {},
    ...over,
  };
}

function claim(
  seq: number,
  stepId: string,
  stepKind: string,
  requirements: RequirementClaim[],
  confirmations?: Confirmation[],
): ClaimRow {
  return {
    seq,
    stepId,
    stepKind,
    claim: {
      stepId,
      outcome: 'done',
      requirements,
      summary: 's',
      ...(confirmations ? { confirmations } : {}),
    },
  };
}

const covered = (id: string, evidence = ['r1']): RequirementClaim => ({
  id,
  state: 'covered',
  evidence,
});
const confirm = (
  id: string,
  verdict: 'confirmed' | 'refuted',
  kind: 'requirement' | 'n/a' = 'requirement',
): Confirmation => ({
  target: { kind, id },
  verdict,
  reason: 'looked',
});

const verdicts = (input: RequirementsInput) =>
  decideRequirements(input).requirements.map((r) => r.verdict);

describe('decideRequirements', () => {
  it('table: each verdict comes only from its typed source', () => {
    const rows: [string, Partial<RequirementsInput>, string[]][] = [
      ['nothing claimed', {}, ['open', 'open']],
      [
        'covered with current evidence',
        { claims: [claim(20, WORK, 'work', [covered(A)])], evidence: { r1: 'current' } },
        ['covered', 'open'],
      ],
      [
        'covered, evidence went stale after the step',
        { claims: [claim(20, WORK, 'work', [covered(A)])], evidence: { r1: { stale: 'moved' } } },
        ['open', 'open'],
      ],
      [
        'covered, evidence not re-read',
        { claims: [claim(20, WORK, 'work', [covered(A)])] },
        ['open', 'open'],
      ],
      [
        'n/a claimed by a work step alone',
        { claims: [claim(20, WORK, 'work', [{ id: A, state: 'n/a', evidence: 'docs' }])] },
        ['open', 'open'],
      ],
      [
        'n/a confirmed by review',
        {
          claims: [
            claim(20, WORK, 'work', [{ id: A, state: 'n/a', evidence: 'docs' }]),
            claim(30, REVIEW, 'review', [], [confirm(A, 'confirmed', 'n/a')]),
          ],
        },
        ['n/a', 'open'],
      ],
      [
        'a confirmation from a non-review step is ignored',
        { claims: [claim(20, WORK, 'work', [], [confirm(A, 'confirmed')])] },
        ['open', 'open'],
      ],
      [
        'review refutes an earlier covered',
        {
          claims: [
            claim(20, WORK, 'work', [covered(A)]),
            claim(30, REVIEW, 'review', [], [confirm(A, 'refuted')]),
          ],
          evidence: { r1: 'current' },
        },
        ['open', 'open'],
      ],
      [
        'human waiver wins over everything',
        { waivers: [{ id: B, reason: 'out of scope', seq: 40 }] },
        ['open', 'waived'],
      ],
    ];
    for (const [name, over, expected] of rows) expect(verdicts(base(over)), name).toEqual(expected);
  });

  it('P16 a derived step after the requirement turns it unknown until a review types it again', () => {
    const before = base({
      claims: [claim(20, WORK, 'work', [covered(A)])],
      derived: [{ stepId: WORK, seq: 25 }],
      evidence: { r1: 'current' },
    });
    const d = decideRequirements(before);
    expect(d.requirements.map((r) => r.verdict)).toEqual(['unknown', 'unknown']);
    expect(d.covered).toBe(false);
    expect(d.missing.join('\n')).toMatch(/R1 .*unknown .*ended derived/);
    const typed = decideRequirements({
      ...before,
      claims: [
        ...before.claims,
        claim(30, REVIEW, 'review', [], [confirm(A, 'confirmed'), confirm(B, 'confirmed')]),
      ],
    });
    expect(typed.requirements.map((r) => r.verdict)).toEqual(['covered', 'covered']);
    expect(typed.covered).toBe(true);
  });

  it('P93 the gate stays closed until a later step reviews the extraction complete; all gaps named at once', () => {
    const allCovered = {
      claims: [claim(20, WORK, 'work', [covered(A), covered(B)])],
      evidence: { r1: 'current' as const },
    };
    const rows: [string, RequirementsInput['reviews'], boolean, RegExp | null][] = [
      ['no review', [], false, /not reviewed against its source/],
      [
        'the extracting step reviewed its own list',
        [{ stepId: PLAN, complete: true, added: [], seq: 12 }],
        false,
        /not reviewed against its source/,
      ],
      [
        'review before the last extraction',
        [{ stepId: REVIEW, complete: true, added: [], seq: 9 }],
        false,
        /not reviewed/,
      ],
      [
        'review found it incomplete',
        [{ stepId: REVIEW, complete: false, added: [], seq: 12 }],
        false,
        /incomplete/,
      ],
      [
        'later complete review',
        [{ stepId: REVIEW, complete: true, added: [], seq: 12 }],
        true,
        null,
      ],
    ];
    for (const [name, reviews, ok, why] of rows) {
      const d = decideRequirements(base({ ...allCovered, reviews }));
      expect(d.extractionReviewed, name).toBe(ok);
      expect(d.covered, name).toBe(ok);
      if (why) expect(d.missing.join('\n'), name).toMatch(why);
    }
    // Ни сверки, ни покрытия: названы и сверка, и каждое открытое требование.
    const none = decideRequirements(base({ reviews: [] }));
    expect(none.missing).toHaveLength(3);
  });

  it('P93 an extractor omitted a point: the review adds it, it stays open until covered, then the gate opens', () => {
    const added = '01920000-0000-7000-8000-00000000a003';
    const input = base({
      requirements: [
        ...base().requirements,
        { id: added, ordinal: 3, text: 'omitted', source: 'review', stepId: REVIEW, seq: 12 },
      ],
      reviews: [{ stepId: REVIEW, complete: true, added: [added], seq: 13 }],
      claims: [claim(20, WORK, 'work', [covered(A), covered(B)])],
      evidence: { r1: 'current' },
    });
    const d = decideRequirements(input);
    expect(d.extractionReviewed).toBe(true);
    expect(d.covered).toBe(false);
    expect(d.missing).toEqual([expect.stringMatching(/^R3 .*: open/)]);
    const fixed = decideRequirements({
      ...input,
      claims: [...input.claims, claim(30, WORK, 'work', [covered(added)])],
    });
    expect(fixed.covered).toBe(true);
  });
});
