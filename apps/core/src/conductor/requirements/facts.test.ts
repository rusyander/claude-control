import { describe, expect, it } from 'vitest';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { bindingOf } from '../model-tools/binding.ts';
import { handleModelTool } from '../model-tools/model-tools.ts';
import {
  R1,
  R2,
  seedRequirements,
  seedSession,
  toolDeps,
} from '../model-tools/__fixtures__/seed.ts';
import type { EvidenceReader } from '../model-tools/model-tools.types.ts';
import { postStepFacts } from './facts.ts';

/**
 * Факты после шага (02:43-47, G22): «покрыто», принятое при заявлении, перечитывается после шага;
 * дерево сдвинулось — требование снова открыто; дифф единицы не прочитался — отказ, а не
 * «ничего не изменено».
 */

async function claimedTask() {
  const { task } = await openFresh();
  seedRequirements(task, [R1, R2]);
  const s = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, s.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const b = bound.binding;
  const deps = toolDeps({ 'rec-green': 'pass' });
  const reply = await handleModelTool(
    task,
    b,
    'step_done',
    {
      stepId: b.stepId,
      outcome: 'done',
      requirements: [
        { id: R1, state: 'covered', evidence: ['rec-green'] },
        { id: R2, state: 'covered', evidence: ['rec-green'] },
      ],
      summary: 'done',
    },
    deps,
  );
  expect(reply).toMatchObject({ ok: true });
  return { task, b, deps };
}

describe('postStepFacts', () => {
  it('G22 covered at claim time stays covered on the same tree and reopens after the tree moved', async () => {
    const { task, b, deps } = await claimedTask();
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const same = await postStepFacts(task, b, lines, 'final', {
      records: deps.records,
      evidence: deps.evidence!,
    });
    if (!('value' in same)) throw new Error(JSON.stringify(same));
    expect(same.value.input.evidence).toEqual({ 'rec-green': 'current' });
    expect(same.value.decision.requirements.map((r) => r.verdict)).toEqual(['covered', 'covered']);
    expect(same.value.changed).toEqual(['src/a.ts']);

    const moved: EvidenceReader = {
      ...deps.evidence!,
      now: async () => ({ value: { key: 'c'.repeat(64), class: 'test-runner', closure: [''] } }),
    };
    const after = await postStepFacts(task, b, lines, 'final', {
      records: deps.records,
      evidence: moved,
    });
    if (!('value' in after)) throw new Error(JSON.stringify(after));
    expect(after.value.input.evidence['rec-green']).toEqual({
      stale: expect.stringMatching(/^stale-evidence: /),
    });
    expect(after.value.decision.requirements.map((r) => r.verdict)).toEqual(['open', 'open']);
    expect(after.value.decision.covered).toBe(false);
    task.close();
  });

  it('git.diff-unit unknown refuses the facts; an unreadable key is unknown standing, never current', async () => {
    const { task, b, deps } = await claimedTask();
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const refused = await postStepFacts(task, b, lines, 'final', {
      records: deps.records,
      evidence: { ...deps.evidence!, changed: async () => ({ unknown: 'git timed out' }) },
    });
    expect(refused).toEqual({ unknown: 'unit diff: git timed out' });
    const doubt = await postStepFacts(task, b, lines, 'final', {
      records: deps.records,
      evidence: { ...deps.evidence!, now: async () => ({ unknown: 'index locked' }) },
    });
    if (!('value' in doubt)) throw new Error(JSON.stringify(doubt));
    expect(doubt.value.input.evidence['rec-green']).toEqual({
      unknown: 'key on the current tree: index locked',
    });
    expect(doubt.value.decision.covered).toBe(false);
    task.close();
  });
});
