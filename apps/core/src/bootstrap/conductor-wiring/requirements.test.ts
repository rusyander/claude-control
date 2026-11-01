import type { StepDef } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { handleModelTool } from '../../conductor/model-tools/model-tools.ts';
import {
  R1,
  R2,
  seedRequirements,
  seedSession,
  toolDeps,
} from '../../conductor/model-tools/__fixtures__/seed.ts';
import type { StepCtx } from '../../conductor/run/run.types.ts';
import { MINI_SCENARIO, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';
import { requirementsHooks } from './requirements.ts';

/**
 * Крючки зоны C на живой задаче: бриф называет требования по id с вердиктом; после шага судья
 * пишет строку решения и изменившиеся вердикты, ворота шага судятся по тем же фактам; крах между
 * `step.claimed` и извлечением дописывается; несчитанный дифф — шаг стоит, а не «ничего не
 * изменено». Подменена только внешняя граница (хранилище записей и дерево — `toolDeps`).
 */

const WORK = MINI_SCENARIO.steps[0] as StepDef;

function wiring(task: LiveTask, deps = toolDeps({ 'rec-green': 'pass' })): ConductorWiringDeps {
  return {
    registry: { live: (id: string) => (id === task.taskId ? task : undefined) },
    verifier: { verify: { records: deps.records, evidence: deps.evidence } },
    note: () => undefined,
  } as unknown as ConductorWiringDeps;
}

function ctx(
  task: LiveTask,
  seeded: { unitId: string; stepId: string; sessionId: string },
  def: StepDef,
): StepCtx {
  return {
    taskId: task.taskId,
    unitId: seeded.unitId,
    repoKey: 'r1',
    copyDir: null,
    stepId: seeded.stepId,
    def,
    round: 0,
    sessionId: seeded.sessionId,
  };
}

describe('requirements hooks', () => {
  it('preStep lists requirements by id with verdicts; an intake with none is told to extract', async () => {
    const { task } = await openFresh();
    const hooks = requirementsHooks(wiring(task));
    const intake = seedSession(task, { stepKind: 'intake' });
    const empty = await hooks.preStep!(ctx(task, intake, { ...WORK, kind: 'intake' }));
    expect(empty.sections).toEqual([
      {
        id: 'requirements',
        from: 'conductor/requirements',
        text: expect.stringMatching(/step_done\.extracted/),
      },
    ]);
    seedRequirements(task, [R1]);
    const work = await hooks.preStep!(ctx(task, intake, WORK));
    expect(work.sections[0]?.text).toContain(`R1 id ${R1} [open]: requirement 1`);
    task.close();
  });

  it('postStep journals the requirements decision and changed verdicts, judges the step gates on the same facts and journals them as class gates', async () => {
    const { task } = await openFresh();
    seedRequirements(task, [R1, R2]);
    const s = seedSession(task, { stepKind: 'work' });
    const bound = bindingOf(task, s.sessionId);
    if (!('binding' in bound)) throw new Error(bound.reason);
    const deps = toolDeps({ 'rec-green': 'pass' });
    const claim = {
      stepId: s.stepId,
      outcome: 'done' as const,
      requirements: [{ id: R1, state: 'covered' as const, evidence: ['rec-green'] }],
      summary: 'done',
    };
    expect(await handleModelTool(task, bound.binding, 'step_done', claim, deps)).toMatchObject({
      ok: true,
    });
    const def: StepDef = {
      ...WORK,
      gate: [{ kind: 'requirements-covered' }, { kind: 'check-green', checkId: 'tests' }],
    };
    const out = await requirementsHooks(wiring(task, deps)).postStep!(ctx(task, s, def), claim);
    expect(out.verdict).toEqual({ ok: true });
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const decision = lines.find(
      (l) => l.kind === 'decision' && (l.data as { class: string }).class === 'requirements',
    );
    expect(decision?.data).toMatchObject({
      class: 'requirements',
      output: {
        covered: false,
        requirements: [
          { id: R1, verdict: 'covered' },
          { id: R2, verdict: 'open' },
        ],
      },
    });
    const verdicts = lines.filter((l) => l.kind === 'requirement.verdict').map((l) => l.data);
    expect(verdicts).toEqual([
      expect.objectContaining({
        requirementId: R1,
        verdict: 'covered',
        evidence: ['rec-green'],
        decisionSeq: decision?.seq,
      }),
    ]);
    expect(out.facts.gates).toEqual({
      passed: false,
      unmet: [
        {
          index: 0,
          kind: 'requirements-covered',
          reason: expect.stringMatching(/not reviewed.*R2 .*open/s),
        },
        { index: 1, kind: 'check-green', reason: 'check tests: record absent' },
      ],
    });
    // Ворота — своё решение класса `gates` поверх строки решения требований, все причины названы.
    const gatesLine = lines.find(
      (l) => l.kind === 'decision' && (l.data as { class: string }).class === 'gates',
    );
    expect(gatesLine?.data).toMatchObject({
      class: 'gates',
      inputs: [decision?.seq],
      facts: [{ readClass: 'check.records', kind: 'value' }],
      numbers: { gates: 2, unmet: 2 },
      reasons: [
        expect.stringMatching(/^requirements-covered: .*not reviewed.*R2 .*open/s),
        'check-green: check tests: record absent',
      ],
      output: out.facts.gates,
    });
    expect(out.facts.gatesDecisionSeq).toBe(gatesLine?.seq);
    // Тот же шаг ещё раз: вердикты не изменились — новых строк вердикта нет.
    await requirementsHooks(wiring(task, deps)).postStep!(ctx(task, s, def), claim);
    expect(
      readJournalLines(task.dir, task.taskId).lines.filter((l) => l.kind === 'requirement.verdict'),
    ).toHaveLength(1);
    task.close();
  });

  it('crash repair: a claimed extraction without its lines is written once by postStep', async () => {
    const { task } = await openFresh();
    const s = seedSession(task, { stepKind: 'intake' });
    const claim = {
      stepId: s.stepId,
      outcome: 'done' as const,
      requirements: [],
      summary: 'read',
      extracted: [{ text: 'a point', source: 'request' as const }],
    };
    // Как после краха: `step.claimed` записан, строк извлечения нет.
    task.append({
      kind: 'step.claimed',
      actor: 'core',
      stepId: s.stepId,
      data: { stepId: s.stepId, sessionId: s.sessionId, claim },
    });
    const hooks = requirementsHooks(wiring(task));
    await hooks.postStep!(ctx(task, s, { ...WORK, kind: 'intake' }), claim);
    await hooks.postStep!(ctx(task, s, { ...WORK, kind: 'intake' }), claim);
    const extracted = readJournalLines(task.dir, task.taskId).lines.filter(
      (l) => l.kind === 'requirement.extracted',
    );
    expect(extracted.map((l) => (l.data as { text: string }).text)).toEqual(['a point']);
    task.close();
  });

  it('git.diff-unit unknown: the step stands with a named reason, no decision line is written', async () => {
    const { task } = await openFresh();
    seedRequirements(task, [R1]);
    const s = seedSession(task, { stepKind: 'work' });
    const deps = toolDeps();
    deps.evidence = { ...deps.evidence!, changed: async () => ({ unknown: 'git timed out' }) };
    const out = await requirementsHooks(wiring(task, deps)).postStep!(ctx(task, s, WORK), null);
    expect(out.verdict).toEqual({
      ok: false,
      stop: 'step',
      code: 'facts-unknown',
      reason: 'unit diff: git timed out',
    });
    expect(readJournalLines(task.dir, task.taskId).lines.some((l) => l.kind === 'decision')).toBe(
      false,
    );
    task.close();
  });
});
