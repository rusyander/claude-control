import { parseCommand } from '@agentdeck/contracts/core/commands';
import { DECISION_CLASS_IDS } from '@agentdeck/contracts/core/decisions';
import { ACTION_KINDS, JOURNAL_DATA_V1, JOURNAL_KINDS } from '@agentdeck/contracts/core/journal';
import { parseStepDone, parseModelCall } from '@agentdeck/contracts/core/model-tools';
import { DIALECT_IDS } from '@agentdeck/stub-model';
import { describe, expect, it } from 'vitest';
import { STEP_DONE_INVALID, STEP_DONE_REFUSED } from '../conductor/model-tools/step-done.ts';
import { fillDeep } from './__fixtures__/script.ts';
import { HAPPY_PATH, READ_IN_PHASE_2, STUB_TASKS } from './__fixtures__/library/index.ts';
import type { Judge, Phase2Probe, StubTask } from './__fixtures__/stub-tasks.types.ts';

/**
 * Библиотека согласована сама с собой (R:S2-25): каждый вид журнала, класс решения, вид
 * действия и вызов инструмента — из контрактов, а не строка на глаз; пробы указывают на
 * существующие ходы; каждый вид действия outbox покрыт обоими срезами краха.
 */

const SAMPLE = { stepId: '01920000-0000-7000-8000-0000000051e9', copy: '/tmp/stub-copy' };

function journalKinds(task: StubTask): string[] {
  const kinds: string[] = [];
  const add = (j?: { present?: string[]; absent?: string[] }) =>
    kinds.push(...(j?.present ?? []), ...(j?.absent ?? []));
  for (const v of task.verdicts) add(v.journal);
  for (const p of task.phase2) {
    if (p.kind === 'model-tool' || p.kind === 'command') add(p.expect.journal);
    if (p.kind === 'reconcile') {
      if (p.expect.then) kinds.push(p.expect.then);
      if (p.expect.pastWindow) kinds.push(p.expect.pastWindow.then);
    }
    if (p.kind === 'model-tool' && p.expect.decision) kinds.push('decision');
  }
  return kinds;
}

function decisionClasses(task: StubTask): string[] {
  const judges: Judge[] = task.verdicts.map((v) => v.judge);
  const fromJudges = judges.flatMap((j) => (j.kind === 'decision' ? [j.class] : []));
  const fromProbes = task.phase2.flatMap((p) =>
    p.kind === 'model-tool' && p.expect.decision ? [p.expect.decision.class] : [],
  );
  return [...fromJudges, ...fromProbes];
}

const reconcileProbes = (): Extract<Phase2Probe, { kind: 'reconcile' }>[] =>
  STUB_TASKS.flatMap((t) => t.phase2).filter(
    (p): p is Extract<Phase2Probe, { kind: 'reconcile' }> => p.kind === 'reconcile',
  );

describe('stub-task library', () => {
  it('ids are unique and the clean happy path is present', () => {
    const ids = STUB_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STUB_TASKS.filter((t) => !t.adversarial).map((t) => t.id)).toContain(HAPPY_PATH.id);
    expect(HAPPY_PATH.e2e?.commits).toBe(1);
  });

  it.each(STUB_TASKS.map((t) => [t.id, t] as const))(
    '%s: journal kinds and decision classes come from the contracts',
    (_id, task) => {
      for (const kind of journalKinds(task)) expect(JOURNAL_KINDS).toContain(kind);
      for (const cls of decisionClasses(task)) expect(DECISION_CLASS_IDS).toContain(cls);
      for (const d of task.dialects) expect(DIALECT_IDS).toContain(d);
      expect(task.verdicts.length).toBeGreaterThan(0);
    },
  );

  it.each(STUB_TASKS.map((t) => [t.id, t] as const))(
    '%s: model-tool moves pass their schema, invalid ones fail it',
    (_id, task) => {
      for (const move of task.moves) {
        if (move.op !== 'model-tool') continue;
        const args = fillDeep(move.args, SAMPLE);
        const parsed =
          move.tool === 'step_done'
            ? parseStepDone(args, task.input.stepKind)
            : parseModelCall(move.tool, args);
        expect(parsed.ok, `${move.tool} ${JSON.stringify(args)}`).toBe(move.invalid !== true);
      }
    },
  );

  it.each(STUB_TASKS.map((t) => [t.id, t] as const))(
    '%s: phase-2 probes point at real moves and use real codes',
    (_id, task) => {
      for (const probe of task.phase2) {
        if (probe.kind === 'model-tool') {
          const move = task.moves[probe.move];
          expect(move?.op).toBe('model-tool');
          for (const s of probe.expect.signals ?? [])
            expect([STEP_DONE_INVALID, STEP_DONE_REFUSED]).toContain(s);
        }
        if (probe.kind === 'permit') expect(task.moves[probe.move]?.op).toBe('shell');
        if (probe.kind === 'command') {
          const parsed = parseCommand({
            cmdId: '01920000-0000-7000-8000-00000000c0de',
            kind: probe.command.kind,
            target: { taskId: SAMPLE.stepId },
            fields: probe.command.fields,
            proof: {},
          });
          expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
          const proof = JOURNAL_DATA_V1['command.received'].shape.proof.safeParse(probe.proof);
          expect(proof.success).toBe(true);
        }
      }
    },
  );

  it('every outbox action kind is cut before and after its effect', () => {
    const probes = reconcileProbes();
    for (const kind of ACTION_KINDS) {
      const cuts = probes.filter((p) => p.action === kind).map((p) => p.cut);
      expect(cuts.sort(), kind).toEqual(['after-effect', 'before-effect']);
    }
    // Факт читается — решение «было/не было»; не читается — повтор, затем человек, но не «нет».
    for (const p of probes) {
      if (READ_IN_PHASE_2.includes(p.action)) {
        expect(p.expect.verdict).toBe(p.cut === 'before-effect' ? 'not-happened' : 'happened');
      } else {
        expect(p.expect).toMatchObject({ verdict: 'retry', pastWindow: { verdict: 'ask' } });
      }
    }
  });

  it('P132 every argv-invisible publish road of 05 waits for forged-publish at phase 6', () => {
    for (const id of [
      'script-file-publish',
      'interpreter-publish',
      'package-script-publish',
      'git-config-shell-edit',
      'hook-triggered-publish',
    ]) {
      const task = STUB_TASKS.find((t) => t.id === id);
      expect(task, id).toBeDefined();
      expect(task!.verdicts, id).toContainEqual(
        expect.objectContaining({
          property: 'P132',
          phase: 6,
          judge: { kind: 'signal', signal: 'forged-publish' },
        }),
      );
      expect(task!.observer.signals, id).toContain('forged-publish');
      // Фаза 2 эту дорогу не видит — проба записывает это, а не прячет.
      const permits = task!.phase2.filter((p) => p.kind === 'permit');
      expect(permits.length, id).toBeGreaterThan(0);
      for (const p of permits) expect(p.expect, id).toEqual({ allow: true });
    }
  });

  it('adversarial cases named by the plan are all present', () => {
    const ids = new Set(STUB_TASKS.map((t) => t.id));
    for (const id of [
      'off-list-blocking-ask',
      'false-done',
      'irrelevant-evidence',
      'reread-loop',
      'forged-publish',
      'hidden-publish-argv',
      'script-file-publish',
      'interpreter-publish',
      'package-script-publish',
      'git-config-shell-edit',
      'hook-triggered-publish',
      'authority-click',
      'cli-initiated-turn',
      'outbox-crash',
    ])
      expect(ids.has(id), id).toBe(true);
  });
});
