import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { bindingOf } from '../model-tools/binding.ts';
import { handleModelTool } from '../model-tools/model-tools.ts';
import { R1, seedRequirements, seedSession, toolDeps } from '../model-tools/__fixtures__/seed.ts';
import { postStepFacts } from './facts.ts';

/**
 * Вердикт второго ревью ничего не одобряет (P185): его подтверждение не закрывает требование,
 * опровергнутое первым ревью, его чистое заявление не снимает блокирующую находку первого, его
 * «извлечение полное» не перекрывает «неполное». Опровержения и находки идут в счёт — они ведут к
 * правке. Второе ревью узнаётся по решению `tier` шага с `numbers.avoided` (суд шёл с исключённым
 * CLI первого ревьюера); без этой строки тот же шаг — обычное ревью, и его подтверждение решает.
 */

type Claim = Record<string, unknown>;

async function claim(task: LiveTask, unitId: string, stepKind: string, body: Claim, cross = false) {
  const s = seedSession(task, { stepKind, unitId });
  if (cross)
    task.append({
      kind: 'decision',
      actor: 'core',
      stepId: s.stepId,
      data: {
        decisionId: newId(),
        class: 'tier',
        inputs: [],
        facts: [],
        numbers: { avoided: 1 },
        reasons: ["route claude/stub avoided: avoidAdapter claude is the first reviewer's"],
        output: { adapter: 'codex' },
      },
    });
  const bound = bindingOf(task, s.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const deps = toolDeps({ 'rec-green': 'pass' });
  const reply = await handleModelTool(
    task,
    bound.binding,
    'step_done',
    { stepId: s.stepId, outcome: 'done', requirements: [], summary: stepKind, ...body },
    deps,
  );
  expect(reply).toMatchObject({ ok: true });
  return { b: bound.binding, deps };
}

const BLOCKING = [{ file: 'src/a.ts', line: 1, severity: 'blocking', text: 'broken' }];
const confirm = (verdict: 'confirmed' | 'refuted') => [
  { target: { kind: 'requirement', id: R1 }, verdict, reason: `${verdict} R1` },
  { target: { kind: 'gate', stepDefId: 'final', index: 0 }, verdict, reason: `${verdict} gate` },
];

async function scene(
  primary: 'confirmed' | 'refuted',
  second: 'confirmed' | 'refuted',
  cross: boolean,
) {
  const { task } = await openFresh();
  seedRequirements(task, [R1]);
  const unitId = newId();
  await claim(task, unitId, 'work', {
    requirements: [{ id: R1, state: 'covered', evidence: ['rec-green'] }],
  });
  await claim(task, unitId, 'review', {
    confirmations: confirm(primary),
    findings: primary === 'refuted' ? BLOCKING : [],
    requirementsReview: { complete: primary === 'confirmed', added: [] },
  });
  const { b, deps } = await claim(
    task,
    unitId,
    'review',
    {
      confirmations: confirm(second),
      findings: second === 'refuted' ? BLOCKING : [],
      requirementsReview: { complete: second === 'confirmed', added: [] },
    },
    cross,
  );
  const lines = readJournalLines(task.dir, task.taskId).lines;
  const facts = await postStepFacts(task, b, lines, 'final', {
    records: deps.records,
    evidence: deps.evidence!,
  });
  task.close();
  if (!('value' in facts)) throw new Error(JSON.stringify(facts));
  const v = facts.value;
  return {
    r1: v.decision.requirements[0]!.verdict,
    extractionReviewed: v.decision.extractionReviewed,
    blocking: 'value' in v.gates.review ? v.gates.review.value.blocking : null,
    gate0: v.gates.confirmations[0],
  };
}

describe('stage 12 P185: the second reviewer (review-cross) never approves, its refutations count', () => {
  it('cross confirmation after a primary refutation: R1 stays open, the blocking finding and the gate refutation stand', async () => {
    expect(await scene('refuted', 'confirmed', true)).toEqual({
      r1: 'open',
      extractionReviewed: false,
      blocking: 1,
      gate0: 'refuted',
    });
  });

  it('cross refutation after a primary confirmation: R1 reopens, its blocking finding and gate refutation count', async () => {
    expect(await scene('confirmed', 'refuted', true)).toEqual({
      r1: 'open',
      extractionReviewed: false,
      blocking: 1,
      gate0: 'refuted',
    });
  });

  it('the same second review without the cross tier decision is an ordinary review: its confirmation decides', async () => {
    expect(await scene('refuted', 'confirmed', false)).toEqual({
      r1: 'covered',
      extractionReviewed: true,
      blocking: 0,
      gate0: 'confirmed',
    });
  });
});
