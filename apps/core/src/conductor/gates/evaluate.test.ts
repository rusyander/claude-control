import type { Gate } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { seedSession } from '../model-tools/__fixtures__/seed.ts';
import { evaluateGates, gateFactsOf, type GateFacts } from './index.ts';

/**
 * Ворота шага (CD§1): каждый вид — только своим типизированным фактом; закрытые названы все;
 * сомнение — закрыто. Ворота `text` закрываются только подтверждением ревью по индексу ворот
 * ЭТОГО шага сценария, проза их не открывает (F16, P32).
 */

const OPEN: GateFacts = {
  stepDefId: 'final',
  requirements: { requirements: [], extractionReviewed: true, covered: true, missing: [] },
  checks: { tests: { value: { recordId: 'r1', verdict: 'pass', current: true } } },
  redBefore: { value: [{ test: 't', base: 'b', final: 'f', outcome: 'proven' }] },
  review: { value: { stepId: 's', blocking: 0 } },
  confirmations: { 4: 'confirmed' },
};

const GATES: Gate[] = [
  { kind: 'requirements-covered' },
  { kind: 'check-green', checkId: 'tests' },
  { kind: 'regression-red-before' },
  { kind: 'review-no-blocking' },
  { kind: 'text', criterion: 'the error is announced' },
];

describe('evaluateGates', () => {
  it('every gate open on its typed fact passes', () => {
    expect(evaluateGates(GATES, OPEN)).toEqual({ passed: true, unmet: [] });
    expect(evaluateGates([], { ...OPEN, checks: {} })).toEqual({ passed: true, unmet: [] });
  });

  it('table: each gate closes on its own missing, red, stale or unreadable fact', () => {
    const rows: [string, Partial<GateFacts>, number, RegExp][] = [
      [
        'requirements open',
        {
          requirements: {
            requirements: [],
            extractionReviewed: false,
            covered: false,
            missing: ['not reviewed', 'R1 x: open'],
          },
        },
        0,
        /not reviewed; R1 x: open/,
      ],
      ['no record', { checks: {} }, 1, /tests: record absent/],
      ['record unreadable', { checks: { tests: { unknown: 'locked' } } }, 1, /unreadable: locked/],
      [
        'record red',
        { checks: { tests: { value: { recordId: 'r1', verdict: 'fail', current: true } } } },
        1,
        /r1 is fail/,
      ],
      [
        'record no-verdict',
        { checks: { tests: { value: { recordId: 'r1', verdict: 'no-verdict', current: true } } } },
        1,
        /is no-verdict/,
      ],
      [
        'green on an older tree',
        { checks: { tests: { value: { recordId: 'r1', verdict: 'pass', current: false } } } },
        1,
        /older tree/,
      ],
      ['no red-before proof', { redBefore: { value: [] } }, 2, /no regression test proven/],
      [
        'green on base',
        { redBefore: { value: [{ test: 't', base: 'b', final: 'f', outcome: 'green-on-base' }] } },
        2,
        /t: green-on-base/,
      ],
      ['red-before unreadable', { redBefore: { unknown: 'engine' } }, 2, /unreadable: engine/],
      ['no review yet', { review: { absent: true } }, 3, /review absent/],
      ['blocking finding', { review: { value: { stepId: 's', blocking: 2 } } }, 3, /2 blocking/],
      ['text not confirmed', { confirmations: {} }, 4, /not confirmed by review \(final#4\)/],
      ['text refuted', { confirmations: { 4: 'refuted' } }, 4, /refuted by review/],
      [
        'confirmation of another gate index',
        { confirmations: { 3: 'confirmed' } },
        4,
        /not confirmed/,
      ],
    ];
    for (const [name, over, index, reason] of rows) {
      const v = evaluateGates(GATES, { ...OPEN, ...over });
      expect(v.passed, name).toBe(false);
      expect(v.unmet, name).toEqual([
        { index, kind: GATES[index]?.kind, reason: expect.stringMatching(reason) },
      ]);
    }
  });

  it('P01 a refusal names every closed gate, not the first', () => {
    const v = evaluateGates(GATES, {
      ...OPEN,
      checks: {},
      review: { absent: true },
      confirmations: {},
    });
    expect(v.unmet.map((u) => u.index)).toEqual([1, 3, 4]);
  });
});

describe('gateFactsOf — journal lines', () => {
  it('reads the latest review findings, this step def gate confirmations and the latest core record per check', async () => {
    const { task } = await openFresh();
    const work = seedSession(task, { stepKind: 'work' });
    const coreRun = newId();
    const sessionRun = newId();
    const laterRun = newId();
    task.append({
      kind: 'check.requested',
      actor: 'core',
      data: {
        checkRunId: coreRun,
        checkId: 'tests',
        unit: '.',
        key: null,
        grade: 'unit',
        origin: 'core',
        road: 'model-tool',
        stepId: work.stepId,
      },
    });
    task.append({
      kind: 'check.recorded',
      actor: 'core',
      data: { checkRunId: coreRun, recordId: 'rec-1' },
    });
    // Захваченный прогон сеанса позже — не запись ворот (P92).
    task.append({
      kind: 'check.requested',
      actor: 'core',
      data: {
        checkRunId: sessionRun,
        checkId: 'tests',
        unit: '.',
        key: null,
        grade: 'unit',
        origin: 'session',
        road: 'capture-wrapper',
        stepId: null,
      },
    });
    task.append({
      kind: 'check.recorded',
      actor: 'core',
      data: { checkRunId: sessionRun, recordId: 'rec-s' },
    });
    task.append({
      kind: 'check.requested',
      actor: 'core',
      data: {
        checkRunId: laterRun,
        checkId: 'lint',
        unit: '.',
        key: null,
        grade: 'unit',
        origin: 'core',
        road: 'conductor',
        stepId: null,
      },
    });
    task.append({
      kind: 'check.recorded',
      actor: 'core',
      data: { checkRunId: laterRun, recordId: 'rec-l' },
    });

    const review = seedSession(task, { stepKind: 'review', unitId: work.unitId });
    task.append({
      kind: 'step.claimed',
      actor: 'core',
      stepId: review.stepId,
      data: {
        stepId: review.stepId,
        sessionId: review.sessionId,
        claim: {
          stepId: review.stepId,
          outcome: 'done',
          requirements: [],
          summary: 'reviewed',
          findings: [
            { file: 'a.ts', line: 1, severity: 'blocking', text: 'x' },
            { file: 'a.ts', line: 2, severity: 'nit', text: 'y' },
          ],
          confirmations: [
            {
              target: { kind: 'gate', stepDefId: 'final', index: 0 },
              verdict: 'confirmed',
              reason: 'ok',
            },
            {
              target: { kind: 'gate', stepDefId: 'final', index: 1 },
              verdict: 'refuted',
              reason: 'no',
            },
            {
              target: { kind: 'gate', stepDefId: 'other', index: 2 },
              verdict: 'confirmed',
              reason: 'ok',
            },
          ],
        },
      },
    });
    const view = gateFactsOf(readJournalLines(task.dir, task.taskId).lines, 'final');
    expect(view).toEqual({
      review: { stepId: review.stepId, blocking: 1 },
      confirmations: { 0: 'confirmed', 1: 'refuted' },
      latestRecords: { tests: 'rec-1', lint: 'rec-l' },
    });
    task.close();
  });
});
