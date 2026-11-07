import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import { CREATED, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import {
  dropAllSeats,
  isParked,
  parkSeat,
  pruneSeatWaits,
  seatAskOf,
  seatsFreed,
  seatWaits,
  takeSeat,
  unparkSeat,
  waitsForSeat,
} from './lease.ts';
import type { SeatAnswer, SeatAsk, SeatPort } from './schedule.types.ts';

/**
 * Место шага на стороне исполнителя (этап 11, P141): строки `schedule` в настоящем журнале задачи,
 * ожидание, парковка на вопросе. Порт распределителя подменён сценарием ответов (очередь машины —
 * свой тест `verifier/queue/session.test.ts`).
 */

class ScriptedPort implements SeatPort {
  answers: SeatAnswer[] = [];
  readonly calls: string[] = [];
  acquire(ask: SeatAsk): Promise<SeatAnswer> {
    this.calls.push(`acquire ${ask.stepId}`);
    return Promise.resolve(this.answers.shift() ?? granted());
  }
  bind(_t: string, stepId: string, sessionId: string): void {
    this.calls.push(`bind ${stepId} ${sessionId}`);
  }
  release(_t: string, stepId: string, why: string): void {
    this.calls.push(`release ${stepId} ${why}`);
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

const decision = { order: [], grant: [], reasons: ['1. u: work'] };
const granted = (): SeatAnswer => ({ granted: true, ticketId: 'tk', decision });
const waiting = (holderTask: string, reason = 'slot'): SeatAnswer => ({
  granted: false,
  ticketId: 'tk',
  reason,
  holder: { taskId: holderTask, sessionId: 's-h' },
  decision,
});

const seen = new WeakMap<LiveTask, JournalLine[]>();

async function runningTask(): Promise<{ task: LiveTask; unitId: string; steps: string[] }> {
  const { task, taskId } = await openFresh();
  const all: JournalLine[] = [];
  seen.set(task, all);
  task.subscribe((line) => all.push(line));
  task.append({ kind: 'task.created', actor: 'core', data: CREATED });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  const unitId = newId();
  task.append({
    kind: 'unit.created',
    actor: 'core',
    unitId,
    data: {
      unitId,
      name: 'u',
      repoKey: 'r1',
      branch: 'b',
      ownedPaths: [],
      after: [],
      contract: false,
      splitId: null,
    },
  });
  const steps = [newId(), newId()];
  for (const stepId of steps)
    task.append({
      kind: 'step.started',
      actor: 'core',
      unitId,
      stepId,
      data: {
        stepId,
        unitId,
        stepKind: 'work',
        stepDefId: 'work',
        round: 0,
        scenario: CREATED.scenario,
        budgetMs: 0,
      },
    } as never);
  return { task, unitId, steps };
}

const schedules = (task: LiveTask) =>
  seen
    .get(task)!
    .filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'schedule')
    .map((l) => (l.data as { output: Record<string, unknown> }).output);

describe('seat lease of a step (P141)', () => {
  it('a waiting step writes one schedule line per holder, not one per wake; the grant after a wait writes "granted"', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    const ask = seatAskOf(task, { stepId: steps[0]!, unitId, def: { kind: 'work' } }, 'r');
    port.answers = [waiting('other'), waiting('other'), waiting('third'), granted()];
    expect(await takeSeat(task, port, ask)).toBe(false);
    expect(await takeSeat(task, port, ask)).toBe(false);
    expect(schedules(task)).toHaveLength(1);
    expect(schedules(task)[0]).toMatchObject({
      grant: [],
      reason: 'slot',
      holder: { taskId: 'other', sessionId: 's-h' },
    });
    expect(waitsForSeat(task, steps[0]!)).toBe(true);
    expect(seatWaits(task)).toEqual({ [steps[0]!]: 'slot' });
    expect(await takeSeat(task, port, ask)).toBe(false);
    expect(schedules(task)).toHaveLength(2);
    expect(await takeSeat(task, port, ask)).toBe(true);
    expect(schedules(task).at(-1)).toMatchObject({ grant: [unitId], ticketId: 'tk' });
    expect(seatWaits(task)).toEqual({});
  });

  it('a seat granted at once writes no line (nobody to wait for)', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    const ask = seatAskOf(task, { stepId: steps[0]!, unitId, def: { kind: 'work' } }, 'r');
    expect(await takeSeat(task, port, ask)).toBe(true);
    expect(schedules(task)).toEqual([]);
  });

  it('seatAskOf: started = another step of the same unit exists; chat is interactive', async () => {
    const { task, unitId, steps } = await runningTask();
    const ask = seatAskOf(task, { stepId: steps[0]!, unitId, def: { kind: 'chat' } }, 'r');
    expect(ask).toMatchObject({ started: true, interactive: true, stepKind: 'chat' });
    const lone = seatAskOf(
      task,
      { stepId: steps[0]!, unitId: 'other', def: { kind: 'work' } },
      'r',
    );
    expect(lone).toMatchObject({ started: false, interactive: false });
  });

  it('seatsFreed clears every wait so the judge tries again', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    port.answers = [waiting('x')];
    await takeSeat(
      task,
      port,
      seatAskOf(task, { stepId: steps[0]!, unitId, def: { kind: 'work' } }, 'r'),
    );
    seatsFreed(task);
    expect(seatWaits(task)).toEqual({});
  });

  it('park releases once and unpark takes the same ask again, then binds the living session', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    const stepId = steps[0]!;
    expect(parkSeat(task, port, stepId, 'sess')).toBe(false); // места не было — нечего отдавать
    const ask = seatAskOf(task, { stepId, unitId, def: { kind: 'work' } }, 'r');
    await takeSeat(task, port, ask);
    expect(parkSeat(task, port, stepId, 'sess')).toBe(true);
    expect(parkSeat(task, port, stepId, 'sess')).toBe(false);
    expect(isParked(task, stepId)).toBe(true);
    expect(port.calls.filter((c) => c.startsWith('release'))).toEqual([
      `release ${stepId} parked on a human ask`,
    ]);
    // Места нет — слово ждёт вместе с местом; повтор без освобождения не просит снова.
    port.answers = [waiting('other')];
    expect(await unparkSeat(task, port, stepId)).toBe(false);
    const asks = port.calls.filter((c) => c.startsWith('acquire')).length;
    expect(await unparkSeat(task, port, stepId)).toBe(false);
    expect(port.calls.filter((c) => c.startsWith('acquire')).length).toBe(asks);
    seatsFreed(task);
    expect(await unparkSeat(task, port, stepId)).toBe(true);
    expect(isParked(task, stepId)).toBe(false);
    expect(port.calls.at(-1)).toBe(`bind ${stepId} sess`);
    // Не стоящий на вопросе шаг — без просьбы.
    expect(await unparkSeat(task, port, steps[1]!)).toBe(true);
  });

  it('prune drops waits of steps that ended or of a task no longer running, keeps a parked one', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    const [a, b] = steps as [string, string];
    await takeSeat(task, port, seatAskOf(task, { stepId: a, unitId, def: { kind: 'work' } }, 'r'));
    parkSeat(task, port, a, 'sess');
    port.answers = [waiting('o'), waiting('o')];
    await unparkSeat(task, port, a);
    await takeSeat(task, port, seatAskOf(task, { stepId: b, unitId, def: { kind: 'work' } }, 'r'));
    pruneSeatWaits(task, port);
    expect(Object.keys(seatWaits(task)).sort()).toEqual([a, b].sort());
    task.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: task.taskId, event: 'pause', from: 'running', to: 'paused' },
    } as never);
    pruneSeatWaits(task, port);
    expect(seatWaits(task)).toEqual({ [a]: 'slot' });
    expect(port.calls).toContain(`release ${b} not waiting`);
    dropAllSeats(task, port, 'task ended');
    expect(seatWaits(task)).toEqual({});
    expect(isParked(task, a)).toBe(false);
    expect(port.calls).toContain(`release ${a} task ended`);
  });

  it('a waiting ticket woken by seatsFreed is still dropped when the task stops before the step asks again', async () => {
    // Пробуждение стирает только «ждёт» для суда; файл ждущего билета лежит, пока его не снимут.
    // Задача встала (или кончилась) раньше повтора просьбы — билет снимается, а не бьётся вечно
    // во главе очереди машины.
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    const [a, b] = steps as [string, string];
    port.answers = [waiting('o'), waiting('o')];
    await takeSeat(task, port, seatAskOf(task, { stepId: a, unitId, def: { kind: 'work' } }, 'r'));
    await takeSeat(task, port, seatAskOf(task, { stepId: b, unitId, def: { kind: 'work' } }, 'r'));
    seatsFreed(task);
    expect(seatWaits(task)).toEqual({});
    task.append({
      kind: 'task.transition',
      actor: 'core',
      data: { taskId: task.taskId, event: 'pause', from: 'running', to: 'paused' },
    } as never);
    pruneSeatWaits(task, port);
    expect(port.calls).toContain(`release ${a} not waiting`);
    dropAllSeats(task, port, 'task ended');
    expect(port.calls).toContain(`release ${b} not waiting`);
  });

  it('dropAllSeats drops a waiting ticket even after seatsFreed cleared its wait', async () => {
    const { task, unitId, steps } = await runningTask();
    const port = new ScriptedPort();
    port.answers = [waiting('o')];
    const stepId = steps[0]!;
    await takeSeat(task, port, seatAskOf(task, { stepId, unitId, def: { kind: 'work' } }, 'r'));
    seatsFreed(task);
    dropAllSeats(task, port, 'task ended');
    expect(port.calls).toContain(`release ${stepId} task ended`);
  });
});
