import { describe, expect, it } from 'vitest';
import type { StepDoneCall } from '@agentdeck/contracts/core/model-tools';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import {
  R1,
  R2,
  RECORD_KEY,
  seedRequirements,
  seedSession,
  toolDeps,
} from './__fixtures__/seed.ts';
import { bindingOf } from './binding.ts';
import { handleModelTool } from './model-tools.ts';
import type { EvidenceReader, ModelToolDeps, SessionBinding } from './model-tools.types.ts';

/**
 * Доказательство `step_done` привязано к задаче, к прогону ядра и к ТЕКУЩЕМУ дереву (02:59-61,
 * P08 P92, G22): зелёная запись чужой задачи, захваченная сеансом, по производному argv
 * `captured:`, со старым ключом, статическая или с замыканием мимо изменённых файлов требование не
 * покрывает; требование цитируется id ядра (G3); извлечение получает id ядра (G4).
 */

async function stepOf(stepKind = 'work', requirements: readonly string[] = [R1, R2]) {
  const fresh = await openFresh();
  seedRequirements(fresh.task, requirements);
  const seeded = seedSession(fresh.task, { stepKind });
  const bound = bindingOf(fresh.task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  return { ...fresh, b: bound.binding };
}

function claim(b: SessionBinding, over: Partial<StepDoneCall> = {}): StepDoneCall {
  return {
    stepId: b.stepId,
    outcome: 'done',
    requirements: [{ id: R1, state: 'covered', evidence: ['rec-green'] }],
    summary: 'did the work',
    ...over,
  };
}

function kinds(task: LiveTask): string[] {
  return readJournalLines(task.dir, task.taskId).lines.map((l) => l.kind);
}

function withEvidence(deps: ModelToolDeps, evidence: Partial<EvidenceReader>): ModelToolDeps {
  return { ...deps, evidence: { ...deps.evidence!, ...evidence } };
}

const OTHER_TASK = '0192f000-0000-7000-8000-0000000000ff';

describe('step_done evidence binding', () => {
  it('a green record of another task, a session-captured one or a derived captured: check is rejected by name', async () => {
    const cases = [
      [{ taskId: OTHER_TASK }, /foreign task/],
      [{ taskId: null }, /foreign task/],
      [{ origin: 'session' }, /captured-evidence: .*not a core run/],
      [{ checkId: 'captured:2f7b30c6' }, /captured-evidence: .*not a registry check/],
    ] as const;
    for (const [facts, problem] of cases) {
      const { task, b } = await stepOf();
      const reply = await handleModelTool(
        task,
        b,
        'step_done',
        claim(b),
        toolDeps({ 'rec-green': facts }),
      );
      expect(reply, JSON.stringify(facts)).toMatchObject({
        ok: false,
        code: 'evidence-rejected',
        issues: [{ path: 'requirements.0.evidence.0', message: expect.stringMatching(problem) }],
      });
      expect(kinds(task)).not.toContain('step.claimed');
      task.close();
    }
    const { task, b } = await stepOf();
    const own = toolDeps({ 'rec-green': 'pass' });
    expect(await handleModelTool(task, b, 'step_done', claim(b), own)).toMatchObject({ ok: true });
    task.close();
  });

  it('G22 a record whose key differs from the key on the current tree is stale; an unreadable key or no reader is stale too', async () => {
    const variants: [string, Partial<EvidenceReader> | 'no-reader', RegExp][] = [
      [
        'moved',
        {
          now: async () => ({
            value: { key: 'b'.repeat(64), class: 'test-runner', closure: [''] },
          }),
        },
        /stale-evidence: rec-green: the tree moved/,
      ],
      [
        'unreadable',
        { now: async () => ({ unknown: 'scratch index locked' }) },
        /stale-evidence: .*not readable: scratch index locked/,
      ],
      ['no-reader', 'no-reader', /stale-evidence: .*no key reader/],
    ];
    for (const [name, reader, problem] of variants) {
      const { task, b } = await stepOf();
      const base = toolDeps({ 'rec-green': 'pass' });
      const deps =
        reader === 'no-reader' ? { ...base, evidence: undefined } : withEvidence(base, reader);
      const reply = await handleModelTool(task, b, 'step_done', claim(b), deps);
      expect(reply, name).toMatchObject({
        ok: false,
        code: 'evidence-rejected',
        issues: [{ message: expect.stringMatching(problem) }],
      });
      expect(kinds(task), name).not.toContain('step.claimed');
      task.close();
    }
    // Тот же ключ — запись свежая, заявление принято.
    const { task, b } = await stepOf();
    const same = withEvidence(toolDeps({ 'rec-green': 'pass' }), {
      now: async (_t, _b, rec) => ({
        value: { key: rec.key, class: 'test-runner', closure: [''] },
      }),
    });
    expect(RECORD_KEY).toHaveLength(64);
    expect(await handleModelTool(task, b, 'step_done', claim(b), same)).toMatchObject({ ok: true });
    task.close();
  });

  it('P92 a static record never covers; a closure missing every changed file is irrelevant; unreadable changed files refuse', async () => {
    const variants: [string, Partial<EvidenceReader>, RegExp | null][] = [
      [
        'static',
        { now: async (_t, _b, r) => ({ value: { key: r.key, class: 'static', closure: [''] } }) },
        /irrelevant-evidence: .*static check/,
      ],
      [
        'closure misses',
        {
          now: async (_t, _b, r) => ({
            value: { key: r.key, class: 'test-runner', closure: ['packages/ui/'] },
          }),
          changed: async () => ({ value: ['apps/web/a.ts'] }),
        },
        /irrelevant-evidence: .*covers none of the files/,
      ],
      [
        'nothing changed',
        { changed: async () => ({ value: [] }) },
        /irrelevant-evidence: .*covers none of the files/,
      ],
      [
        'diff unknown',
        { changed: async () => ({ unknown: 'timeout after 30000 ms' }) },
        /irrelevant-evidence: .*not readable: timeout/,
      ],
      [
        'closure hits',
        {
          now: async (_t, _b, r) => ({
            value: { key: r.key, class: 'test-runner', closure: ['packages/ui/', 'apps/web'] },
          }),
          changed: async () => ({ value: ['apps/web/a.ts'] }),
        },
        null,
      ],
    ];
    for (const [name, reader, problem] of variants) {
      const { task, b } = await stepOf();
      const deps = withEvidence(toolDeps({ 'rec-green': 'pass' }), reader);
      const reply = await handleModelTool(task, b, 'step_done', claim(b), deps);
      if (problem === null) expect(reply, name).toMatchObject({ ok: true });
      else
        expect(reply, name).toMatchObject({
          ok: false,
          code: 'evidence-rejected',
          issues: [{ message: expect.stringMatching(problem) }],
        });
      task.close();
    }
  });

  it('G3 a claim citing an id the core never issued is a field error; P72 call errors are listed once, then counted; P08 an evidence refusal is never counted', async () => {
    const { task, b } = await stepOf('work', [R1]);
    const unknownId = claim(b, {
      requirements: [
        { id: R1, state: 'covered', evidence: ['rec-green'] },
        { id: R2, state: 'n/a', evidence: 'docs only' },
      ],
    });
    const first = await handleModelTool(
      task,
      b,
      'step_done',
      unknownId,
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(first).toMatchObject({
      ok: false,
      code: 'invalid',
      issues: [
        { path: 'requirements.1.id', message: expect.stringMatching(/^unknown-requirement: /) },
      ],
    });
    const second = await handleModelTool(
      task,
      b,
      'step_done',
      unknownId,
      toolDeps({ 'rec-green': 'pass' }),
    );
    expect(second).toMatchObject({ ok: false, code: 'invalid-repeat' });
    expect(second).not.toHaveProperty('issues');
    // Отказ по доказательству после двух счётных: снова с полями и сигналом ложного «готово».
    for (let n = 0; n < 2; n += 1) {
      const refused = await handleModelTool(task, b, 'step_done', claim(b), toolDeps({}));
      expect(refused).toMatchObject({
        ok: false,
        code: 'evidence-rejected',
        issues: [{ path: 'requirements.0.evidence.0' }],
      });
    }
    const signals = readJournalLines(task.dir, task.taskId)
      .lines.filter((l) => l.kind === 'signal')
      .map((l) => (l.data as { signal: string }).signal);
    expect(signals).toEqual([
      'step-done-invalid',
      'step-done-invalid',
      'step-done-refused',
      'step-done-refused',
    ]);
    expect(task.state.steps[b.stepId]?.state).toBe('running');
    task.close();
  });
});

describe('step_done extraction', () => {
  it('G3 G4 extracted points get core UUIDv7 ids in order, the reply names them; a later review restores an omitted point', async () => {
    const { task, b } = await stepOf('intake', []);
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      {
        stepId: b.stepId,
        outcome: 'done',
        requirements: [],
        summary: 'read the ticket',
        extracted: [
          { text: 'the button shows the error', source: 'ticket' },
          { text: 'the form keeps its input', source: 'ticket' },
        ],
      },
      toolDeps(),
    );
    expect(reply).toMatchObject({ ok: true });
    const minted = (reply as { result: { requirements: { id: string; ordinal: number }[] } }).result
      .requirements;
    expect(minted.map((r) => r.ordinal)).toEqual([1, 2]);
    for (const r of minted) expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(kinds(task).filter((k) => k === 'requirement.extracted')).toHaveLength(2);
    expect(kinds(task).indexOf('step.claimed')).toBeLessThan(
      kinds(task).indexOf('requirement.extracted'),
    );

    // Ревью следующего шага сверяет список с источником и добавляет пропущенное (P93).
    const review = seedSession(task, { stepKind: 'review', unitId: b.unitId });
    const rb = bindingOf(task, review.sessionId);
    if (!('binding' in rb)) throw new Error(rb.reason);
    const reviewed = await handleModelTool(
      task,
      rb.binding,
      'step_done',
      {
        stepId: review.stepId,
        outcome: 'done',
        requirements: [],
        summary: 'compared the list with the ticket',
        requirementsReview: {
          complete: true,
          added: [{ text: 'the error is announced to screen readers' }],
        },
      },
      toolDeps(),
    );
    expect(reviewed).toMatchObject({ ok: true, result: { requirements: [{ ordinal: 3 }] } });
    const lines = readJournalLines(task.dir, task.taskId).lines;
    const restored = lines.filter((l) => l.kind === 'requirement.extracted').at(-1);
    expect(restored?.data).toMatchObject({ ordinal: 3, source: 'review', stepId: review.stepId });
    const rev = lines.find((l) => l.kind === 'requirement.reviewed');
    expect(rev?.data).toEqual({
      stepId: review.stepId,
      complete: true,
      added: [(restored?.data as { requirementId: string }).requirementId],
    });
    task.close();
  });

  it('G4 a plan step cannot review its own extraction in the same call', async () => {
    const { task, b } = await stepOf('plan', []);
    const reply = await handleModelTool(
      task,
      b,
      'step_done',
      {
        stepId: b.stepId,
        outcome: 'done',
        requirements: [],
        summary: 'planned',
        extracted: [{ text: 'a', source: 'request' }],
        requirementsReview: { complete: true, added: [] },
      },
      toolDeps(),
    );
    expect(reply).toMatchObject({
      ok: false,
      code: 'invalid',
      issues: [{ path: 'requirementsReview' }],
    });
    expect(kinds(task)).not.toContain('requirement.extracted');
    task.close();
  });
});
