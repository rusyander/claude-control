import { parseCommand } from '@agentdeck/contracts/core/commands';
import { DECISION_CLASS_IDS } from '@agentdeck/contracts/core/decisions';
import { ACTION_KINDS, JOURNAL_DATA_V1, JOURNAL_KINDS } from '@agentdeck/contracts/core/journal';
import { parseStepDone, parseModelCall } from '@agentdeck/contracts/core/model-tools';
import { DIALECT_IDS } from '@agentdeck/stub-model';
import { describe, expect, it } from 'vitest';
import { STEP_DONE_INVALID, STEP_DONE_REFUSED } from '../conductor/model-tools/step-done.ts';
import type { StepContext } from '@agentdeck/stub-model';
import { fillDeep, moveAt, stepFor } from './__fixtures__/script.ts';
import { HAPPY_PATH, READ_BY_FACT, STUB_TASKS } from './__fixtures__/library/index.ts';
import { GUARD_ROAD_RUNS } from './__fixtures__/library/stage6-g.ts';
import type {
  Judge,
  Move,
  Phase2Probe,
  Phase4Probe,
  StubTask,
  TimedMove,
} from './__fixtures__/stub-tasks.types.ts';

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
  for (const p of task.phase4 ?? []) add(p.expect.journal);
  return kinds;
}

/**
 * Пробы этапа 4 против контрактов: вид строки, класс решения и тело каждой команды — настоящие.
 * Отдельной функцией, чтобы её можно было увидеть красной на заведомо плохой пробе: каталог
 * этапа 4 пуст до волны 1, и проверка на нём одном ничего бы не доказала.
 */
function phase4Problems(probe: Phase4Probe): string[] {
  const problems: string[] = [];
  const { present = [], absent = [] } = probe.expect.journal;
  for (const kind of [...present, ...absent])
    if (!(JOURNAL_KINDS as readonly string[]).includes(kind)) problems.push(`journal ${kind}`);
  for (const cls of probe.expect.decisions ?? [])
    if (!(DECISION_CLASS_IDS as readonly string[]).includes(cls)) problems.push(`decision ${cls}`);
  for (const command of probe.commands ?? []) {
    const parsed = parseCommand({
      cmdId: '01920000-0000-7000-8000-00000000c0de',
      kind: command.kind,
      target: { taskId: SAMPLE.stepId },
      fields: command.fields,
      proof: {},
    });
    if (!parsed.ok) problems.push(`command ${command.kind}`);
  }
  return problems;
}

function decisionClasses(task: StubTask): string[] {
  const judges: Judge[] = task.verdicts.map((v) => v.judge);
  const fromJudges = judges.flatMap((j) => (j.kind === 'decision' ? [j.class] : []));
  const fromProbes = task.phase2.flatMap((p) =>
    p.kind === 'model-tool' && p.expect.decision ? [p.expect.decision.class] : [],
  );
  const fromStage4 = (task.phase4 ?? []).flatMap((p) => p.expect.decisions ?? []);
  return [...fromJudges, ...fromProbes, ...fromStage4];
}

/** Поля ходов этапа 8 (окно чтения, код выхода подделки CLI) — отдельной функцией, чтобы видеть её красной. */
function moveProblems(move: TimedMove): string[] {
  const problems: string[] = [];
  if (move.op === 'read' && move.range) {
    const { offset, limit } = move.range;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
      problems.push(`range ${JSON.stringify(move.range)}`);
  }
  if (move.op === 'shell' && move.exit !== undefined) {
    if (!Number.isInteger(move.exit) || move.exit < 0 || move.exit > 255)
      problems.push(`exit ${move.exit}`);
  }
  return problems;
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

  it('stage-4 probes: every journal kind, decision class and command body comes from the contracts', () => {
    for (const task of STUB_TASKS)
      for (const probe of task.phase4 ?? [])
        expect({ task: task.id, problems: phase4Problems(probe) }).toEqual({
          task: task.id,
          problems: [],
        });
    // Проверка видна красной: выдуманный вид строки, класс и команда без обязательного поля.
    const bad: Phase4Probe = {
      zone: 'B',
      property: 'P16',
      commands: [{ kind: 'pause', fields: {} }],
      expect: { journal: { present: ['no.such' as never] }, decisions: ['no-such' as never] },
    };
    expect(phase4Problems(bad)).toEqual(['journal no.such', 'decision no-such', 'command pause']);
  });

  it('every outbox action kind is cut before and after its effect', () => {
    const probes = reconcileProbes();
    for (const kind of ACTION_KINDS) {
      const cuts = probes.filter((p) => p.action === kind).map((p) => p.cut);
      expect(cuts.sort(), kind).toEqual(['after-effect', 'before-effect']);
    }
    // Факт читается — решение «было/не было»; не читается — повтор, затем человек, но не «нет».
    for (const p of probes) {
      if (READ_BY_FACT.includes(p.action)) {
        expect(p.expect.verdict).toBe(p.cut === 'before-effect' ? 'not-happened' : 'happened');
      } else {
        expect(p.expect).toMatchObject({ verdict: 'retry', pastWindow: { verdict: 'ask' } });
      }
    }
  });

  it('P132 every argv-invisible publish road of 05 is run at phase 6 in both variants', () => {
    const runs = Object.keys(GUARD_ROAD_RUNS);
    for (const road of ['script-file', 'interpreter', 'package-script', 'git-config-shell-edit']) {
      expect(runs).toContain(road === 'git-config-shell-edit' ? road : `${road}-publish`);
      expect(runs).toContain(`${road}-bypass`);
    }
    expect(runs).toContain('hook-triggered-publish');
    expect(runs).toContain('hook-triggered-bypass');
    for (const id of runs) {
      const task = STUB_TASKS.find((t) => t.id === id);
      expect(task, id).toBeDefined();
      const verdict = task!.verdicts.find((v) => v.property === 'P132');
      expect(verdict, id).toMatchObject({
        phase: 6,
        judge: { kind: 'signal', signal: 'forged-publish' },
      });
      // Сигнал ждут ровно там, где исполнитель ждёт улик; remote сдвинут — улика обязана быть.
      const evidence = GUARD_ROAD_RUNS[id]!.evidence;
      expect(task!.observer.signals, id).toEqual(evidence.length > 0 ? ['forged-publish'] : []);
      if (GUARD_ROAD_RUNS[id]!.remote === 'moved') expect(evidence.length, id).toBeGreaterThan(0);
      // Фаза 2 эту дорогу не видит — проба записывает это, а не прячет.
      const permits = task!.phase2.filter((p) => p.kind === 'permit');
      expect(permits.length, id).toBeGreaterThan(0);
      for (const p of permits) expect(p.expect, id).toEqual({ allow: true });
    }
  });

  it('stage-8 move fields are well formed: read range, faked exit code, turn-end mark', () => {
    for (const task of STUB_TASKS)
      expect({ task: task.id, problems: task.moves.flatMap(moveProblems) }).toEqual({
        task: task.id,
        problems: [],
      });
    // Проверка видна красной: окно с отрицательным началом и пустое, код выхода не байт.
    const bad: TimedMove[] = [
      { op: 'read', path: 'a', range: { offset: -1, limit: 0 } },
      { op: 'shell', argv: ['x'], exit: 256 },
    ];
    expect(bad.flatMap(moveProblems)).toEqual(['range {"offset":-1,"limit":0}', 'exit 256']);
  });

  it('stage-8 read range lands only in the fields the read tool declares', () => {
    const read = (props: Record<string, unknown>) =>
      ({
        dialect: 'anthropic-messages',
        request: { body: { messages: [] } },
        info: { tools: [{ name: 'Read', schema: { type: 'object', properties: props } }] },
      }) as unknown as StepContext;
    const move: Move = { op: 'read', path: 'src/a.ts', range: { offset: 40, limit: 20 } };
    expect(stepFor(move, read({ file_path: {}, offset: {}, limit: {} }))).toEqual({
      tool: { name: 'Read', args: { file_path: 'src/a.ts', offset: 40, limit: 20 } },
    });
    // Инструмент без полей окна — чтение целиком, не выдуманные аргументы.
    expect(stepFor(move, read({ file_path: {} }))).toEqual({
      tool: { name: 'Read', args: { file_path: 'src/a.ts' } },
    });
  });

  it('stage-8 turnEnd puts one text answer after the marked move; the next move follows it', () => {
    const a: TimedMove = { op: 'read', path: 'a', turnEnd: true };
    const b: TimedMove = { op: 'read', path: 'b' };
    expect([0, 1, 2, 3].map((n) => moveAt([a, b], n))).toEqual([a, 'turn-end', b, undefined]);
    expect([0, 1, 2].map((n) => moveAt([b, a], n))).toEqual([b, a, 'turn-end']);
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
