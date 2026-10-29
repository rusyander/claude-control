import { describe, expect, it } from 'vitest';
import { dataSchemaFor, JOURNAL_VERSION } from '@agentdeck/contracts/core/journal';
import {
  MACHINES,
  TASK_ENDED_OUTCOME,
  TASK_MACHINE,
  taskEndedOutcome,
  type MachineDef,
  type TaskState,
} from '@agentdeck/contracts/core/states';

/**
 * Модельная проверка машин состояний (01 §State, F09, P17) по данным `core/states.ts`: перебор
 * каждой пары (состояние, событие), выходы и сроки нетерминальных состояний, достижимость конца.
 * Проверка — функция над определением машины: испорченные копии обязаны дать нарушения, иначе
 * зелёный цвет ничего не значит.
 */

type AnyMachine = MachineDef<string, string>;

function rulesFor(m: AnyMachine, state: string, event: string) {
  return m.transitions.filter((t) => t.on === event && t.from.includes(state));
}

function successors(m: AnyMachine, state: string): string[] {
  return m.transitions
    .filter((t) => t.from.includes(state) && t.to !== 'same' && t.to !== state)
    .map((t) => t.to);
}

function reach(m: AnyMachine, from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    for (const to of successors(m, at)) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

function machineViolations(m: AnyMachine): string[] {
  const out: string[] = [];
  const states = new Set(m.states);
  const terminal = new Set(m.terminal);
  if (!states.has(m.initial)) out.push(`${m.name}: initial ${m.initial} is not a state`);
  for (const t of m.terminal) if (!states.has(t)) out.push(`${m.name}: terminal ${t} unknown`);
  for (const t of m.transitions) {
    if (!m.events.includes(t.on)) out.push(`${m.name}: rule on unknown event ${t.on}`);
    for (const f of t.from) if (!states.has(f)) out.push(`${m.name}: rule from unknown ${f}`);
    if (t.to !== 'same' && !states.has(t.to)) out.push(`${m.name}: rule to unknown ${t.to}`);
  }
  for (const state of m.states) {
    for (const event of m.events) {
      const rules = rulesFor(m, state, event);
      // Пара определена: одно правило или ни одного (тогда событие отклоняется — `unmatched`).
      if (rules.length > 1) out.push(`${m.name}: (${state}, ${event}) has ${rules.length} rules`);
      // Конец — конец: из него разрешено только «записано, состояние то же».
      if (terminal.has(state) && rules.some((r) => r.to !== 'same'))
        out.push(`${m.name}: terminal ${state} leaves on ${event}`);
    }
    if (terminal.has(state)) continue;
    if (successors(m, state).length === 0) out.push(`${m.name}: ${state} has no exit`);
    const deadline = m.deadlines[state];
    if (!deadline && !m.exitOwner[state])
      out.push(`${m.name}: ${state} has neither a deadline nor an exit owner`);
    if (deadline && rulesFor(m, state, deadline.event).length !== 1)
      out.push(`${m.name}: ${state} deadline event ${deadline.event} has no rule`);
  }
  const reachable = reach(m, m.initial);
  for (const state of m.states) {
    if (!reachable.has(state)) out.push(`${m.name}: ${state} unreachable from ${m.initial}`);
  }
  for (const state of reachable) {
    if (![...reach(m, state)].some((s) => terminal.has(s)))
      out.push(`${m.name}: no terminal reachable from ${state}`);
  }
  if (m.unmatched !== 'reject') out.push(`${m.name}: unmatched events must be rejected`);
  return out;
}

/** Конец задачи → `task.ended`: исход есть у каждого конца, и его принимает схема журнала. */
function taskEndViolations(m: MachineDef<TaskState, string>, outcomes: Record<string, string>) {
  const out: string[] = [];
  const schema = dataSchemaFor(JOURNAL_VERSION, 'task.ended');
  for (const t of m.terminal) {
    const outcome = outcomes[t];
    if (!outcome) out.push(`task terminal ${t} has no task.ended outcome`);
    else if (!schema?.safeParse({ outcome }).success)
      out.push(`task terminal ${t}: outcome ${outcome} rejected by the journal schema`);
  }
  for (const key of Object.keys(outcomes)) {
    if (!m.terminal.includes(key as TaskState)) out.push(`outcome for non-terminal ${key}`);
  }
  return out;
}

const clone = (m: AnyMachine): AnyMachine => JSON.parse(JSON.stringify(m)) as AnyMachine;

describe('state machines', () => {
  it('P17 every machine: each (state, event) has at most one rule, non-terminal states exit or carry a deadline, every reachable state reaches an end', () => {
    const report = Object.values(MACHINES).flatMap((m) => machineViolations(m as AnyMachine));
    expect(report).toEqual([]);
    // Перебор действительно прошёл всё произведение, а не пустой список.
    const pairs = Object.values(MACHINES).reduce(
      (n, m) => n + m.states.length * m.events.length,
      0,
    );
    expect(pairs).toBeGreaterThan(300);
  });

  it('P17 every task end produces task.ended with an outcome the journal accepts; nothing else does', () => {
    expect(taskEndViolations(TASK_MACHINE, TASK_ENDED_OUTCOME)).toEqual([]);
    for (const state of TASK_MACHINE.states) {
      const outcome = taskEndedOutcome(state);
      expect({ state, ends: outcome !== null }).toEqual({
        state,
        ends: TASK_MACHINE.terminal.includes(state),
      });
    }
  });

  it('P17 the checker goes red on each kind of broken machine', () => {
    const base = TASK_MACHINE as unknown as AnyMachine;
    const mutants: [string, (m: AnyMachine) => void, RegExp][] = [
      [
        'duplicate rule',
        (m) => {
          (m.transitions as unknown[]).push({ on: 'launch', from: ['draft'], to: 'paused' });
        },
        /\(draft, launch\) has 2 rules/,
      ],
      [
        'state without exit',
        (m) => {
          (m as unknown as { transitions: unknown[] }).transitions = m.transitions.map((t) => ({
            ...t,
            from: t.from.filter((f) => f !== 'paused'),
          }));
        },
        /paused has no exit/,
      ],
      [
        'no deadline, no owner',
        (m) => {
          delete (m.exitOwner as Record<string, string>)['awaiting-launch'];
        },
        /awaiting-launch has neither/,
      ],
      [
        'deadline without its rule',
        (m) => {
          (m as unknown as { transitions: unknown[] }).transitions = m.transitions.filter(
            (t) => !(t.on === 'deadline' && t.from.includes('estimating')),
          );
        },
        /estimating deadline event deadline has no rule/,
      ],
      [
        'terminal leaves',
        (m) => {
          (m.transitions as unknown[]).push({ on: 'resume', from: ['done'], to: 'running' });
        },
        /terminal done leaves/,
      ],
      [
        'unreachable state',
        (m) => {
          (m.states as string[]).push('orphan');
          (m.exitOwner as Record<string, string>).orphan = 'nobody';
          (m.transitions as unknown[]).push({ on: 'cancel', from: ['orphan'], to: 'cancelled' });
        },
        /orphan unreachable/,
      ],
      [
        'trap cycle',
        (m) => {
          (m.states as string[]).push('limbo-a', 'limbo-b');
          (m.exitOwner as Record<string, string>)['limbo-a'] = 'x';
          (m.exitOwner as Record<string, string>)['limbo-b'] = 'x';
          (m.transitions as unknown[]).push(
            { on: 'estimate', from: ['awaiting-launch'], to: 'limbo-a' },
            { on: 'resume', from: ['limbo-a'], to: 'limbo-b' },
            { on: 'pause', from: ['limbo-b'], to: 'limbo-a' },
          );
        },
        /no terminal reachable from limbo-a/,
      ],
    ];
    for (const [name, mutate, expected] of mutants) {
      const copy = clone(base);
      mutate(copy);
      expect({ name, report: machineViolations(copy).join('\n') }).toEqual({
        name,
        report: expect.stringMatching(expected),
      });
    }
    const noOutcome = { ...TASK_ENDED_OUTCOME } as Record<string, string>;
    delete noOutcome.failed;
    expect(taskEndViolations(TASK_MACHINE, noOutcome)).toEqual([
      'task terminal failed has no task.ended outcome',
    ]);
    expect(
      taskEndViolations(TASK_MACHINE, { ...TASK_ENDED_OUTCOME, cancelled: 'aborted' }),
    ).toEqual(['task terminal cancelled: outcome aborted rejected by the journal schema']);
  });
});
