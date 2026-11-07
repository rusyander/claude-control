import { describe, expect, it } from 'vitest';
import type { IntakeCard, IntakeSource } from '@agentdeck/contracts/core/intake';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { maskSink } from '../../context/sinks/sinks.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { cardFromClaim, cardFromSources } from './card.ts';
import type { IntakeInput } from './intake.types.ts';
import { decideIntake } from './judge.ts';
import {
  intakeAsk,
  intakeAnswerOf,
  leadAnswerFits,
  classAsk,
  INTAKE_ANSWERS,
} from './questions.ts';
import { maskedSource, sourcesOf, trackerSourceProblem } from './source.ts';

/**
 * Приём (W2-6): карточка одним судом схемы (пятая развилка, рекомендация вне вариантов — отказ с
 * причиной), «сама» только при структурных непустых неповторных критериях без развилок и без
 * `alwaysAsk`, тело источника под маской DLP, один вопрос со всеми развилками.
 */

const SHA = 'b'.repeat(64);
const SECRET = `glpat-${'q'.repeat(20)}`;
const mask = (t: string) => maskSink(t, 'brief').text;

const tracker = (over: Partial<IntakeSource> = {}): IntakeSource => ({
  kind: 'tracker',
  key: 'PROJ-1',
  title: 'Fix login',
  body: 'body',
  acceptance: ['the form logs in', 'an error is shown on a bad password'],
  fetchedAt: 1,
  digest: SHA,
  ...over,
});

const rows = [
  { id: newId(), text: 'the form logs in', source: 'ticket' as const },
  { id: newId(), text: 'an error is shown on a bad password', source: 'ticket' as const },
];

const fork = (i: number, chosen = 'a') => ({
  question: `fork ${i}?`,
  options: ['a', 'b'],
  chosen,
  reason: 'canonical default',
});

const claim = (forks: StepDoneCall['forks']): StepDoneCall => ({
  stepId: newId(),
  outcome: 'done',
  requirements: [],
  summary: 'Fix the login form',
  ...(forks ? { forks } : {}),
});

function cardOf(unknowns = 0): IntakeCard {
  const built = cardFromClaim(
    claim(Array.from({ length: unknowns }, (_, i) => fork(i))),
    null,
    rows,
    [],
    SHA,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.card;
}

describe('intake card: one schema judge', () => {
  it('four forks build a card, each with its recommendation', () => {
    expect(cardOf(4).unknowns.map((u) => u.recommendation)).toEqual(['a', 'a', 'a', 'a']);
  });

  it('a fifth fork is refused with the reason, not trimmed', () => {
    const built = cardFromClaim(claim([0, 1, 2, 3, 4].map((i) => fork(i))), null, rows, [], SHA);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues.join(' ')).toMatch(/^unknowns: /);
  });

  it('a recommendation outside the options is refused', () => {
    const built = cardFromClaim(claim([fork(0, 'c')]), null, rows, [], SHA);
    expect(built.ok).toBe(false);
    if (!built.ok)
      expect(built.issues).toContain(
        'unknowns.0.recommendation: recommendation must be one of the options',
      );
  });

  it('the card acceptance rows are the requirement rows, one numbering', () => {
    const built = cardFromSources([tracker()], rows, SHA, 'req');
    expect(built.ok && built.card.acceptance.map((a) => a.requirementId)).toEqual(
      rows.map((r) => r.id),
    );
    expect(built.ok && built.card.goal).toBe('Fix login');
  });
});

describe('intake judge: auto only when there is nothing to understand', () => {
  const base: Omit<IntakeInput, 'sources'> = { card: cardOf(0), alwaysAsk: [] };

  it('tracker with structured acceptance, no forks → auto', () => {
    const d = decideIntake({ ...base, sources: [tracker()] });
    expect(d.verdict).toBe('auto');
    expect(d.structuredAcceptance).toBe(2);
  });

  it('tracker without acceptance → ask', () => {
    const d = decideIntake({ ...base, sources: [tracker({ acceptance: undefined })] });
    expect(d.verdict).toBe('ask');
    expect(d.reasons.join(' ')).toContain('no acceptance criteria');
  });

  it('a blank criterion → ask', () => {
    const d = decideIntake({ ...base, sources: [tracker({ acceptance: ['ok', '  '] })] });
    expect(d.verdict).toBe('ask');
  });

  it('repeated criteria → ask', () => {
    const d = decideIntake({ ...base, sources: [tracker({ acceptance: ['same', 'same '] })] });
    expect(d.reasons).toContain('acceptance criteria repeat');
  });

  it('one open fork → ask', () => {
    expect(decideIntake({ ...base, card: cardOf(1), sources: [tracker()] }).verdict).toBe('ask');
  });

  it('intake in alwaysAsk → ask', () => {
    const d = decideIntake({ ...base, alwaysAsk: ['intake'], sources: [tracker()] });
    expect(d).toMatchObject({ verdict: 'ask', alwaysAsk: true });
  });

  it('a text request with no snapshot → ask', () => {
    const d = decideIntake({ ...base, sources: [] });
    expect(d.verdict).toBe('ask');
    expect(d.reasons[0]).toBe('no source snapshot: the request is prose');
  });

  it('a text source among structured ones → ask', () => {
    const text: IntakeSource = { kind: 'text', body: 'x', fetchedAt: 1, digest: SHA };
    expect(decideIntake({ ...base, sources: [tracker(), text] }).verdict).toBe('ask');
  });
});

describe('intake sources', () => {
  it('source and sources together is a named problem', () => {
    const got = sourcesOf({ source: tracker(), sources: [tracker()] });
    expect(got).toEqual({ ok: false, problem: expect.stringContaining('not both') });
  });

  it('the snapshot key, body, title, criteria and links go under the DLP mask', () => {
    const got = maskedSource(
      tracker({
        key: `PROJ-1 ${SECRET}`,
        body: `token ${SECRET}`,
        title: `t ${SECRET}`,
        acceptance: [`ac ${SECRET}`],
        links: [{ url: `https://tracker.example.com/f?private_token=${SECRET}`, title: SECRET }],
      }),
      mask,
    );
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(JSON.stringify(got)).not.toContain('q'.repeat(12));
  });

  it('tracker-ticket@2 without a tracker snapshot is refused; @1 is not', () => {
    expect(trackerSourceProblem('tracker-ticket', 2, [])).toMatch(/needs a tracker snapshot/);
    expect(trackerSourceProblem('tracker-ticket', 1, [])).toBeNull();
    expect(trackerSourceProblem('tracker-ticket', 2, [tracker()])).toBeNull();
  });
});

describe('intake question: one ask with every fork', () => {
  const taskId = newId();

  it('carries each fork with its recommendation and the confirm/stop options', () => {
    const ask = intakeAsk(taskId, cardOf(3), 'en');
    expect(ask).toMatchObject({ source: 'intake', point: 10, stepId: null, blocking: true });
    expect(ask.question.match(/Recommended: “a”/g)).toHaveLength(3);
    expect(ask.options).toEqual(Object.values(INTAKE_ANSWERS.en));
    expect(ask.recommendation).toBe(INTAKE_ANSWERS.en.confirm);
  });

  it('answers are matched in every language; foreign text does not fit', () => {
    expect(intakeAnswerOf(INTAKE_ANSWERS.ru.stop)).toBe('stop');
    expect(leadAnswerFits(taskId, `intake:${taskId}`, 'maybe')).toBe(false);
    expect(leadAnswerFits(taskId, `classify:${taskId}`, 'M')).toBe(true);
    expect(leadAnswerFits(taskId, 'other', 'x')).toBeNull();
  });

  it('the class ask offers every class and recommends the computed one', () => {
    const ask = classAsk(taskId, 'M', 'files 5 ≤ 10', 'ru');
    expect(ask.options).toEqual(['S', 'M', 'L', 'XL']);
    expect(ask.recommendation).toBe('M');
  });
});
