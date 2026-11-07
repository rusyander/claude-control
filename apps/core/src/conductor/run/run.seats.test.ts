import { describe, expect, it } from 'vitest';
import { raiseHumanPoint } from '../human/raise.ts';
import type { SeatAnswer, SeatAsk, SeatPort } from '../schedule/schedule.types.ts';
import { stand, type Stand } from './__fixtures__/run-harness.ts';

/**
 * Места сеансов в исполнителе задачи (этап 11, P141) — то, что `runTask` делает с портом мест:
 * сеанс встал в конце хода на открытом вопросе человеку — место отдаётся; ответ человека уходит в
 * сеанс только после возврата места (нет места — слово ждёт до пробуждения порта); сеанс кончился
 * сам — место сразу; снятие исполнителя отпускает места и отписывается от порта. Подменён только
 * порт распределителя (очередь машины — свой тест); журнал, суд `next`, ответ — настоящие.
 */

const FEATURE = { id: 'feature', version: 1 };
const decision = { order: [], grant: [], reasons: ['1. u: work'] };
const granted = (): SeatAnswer => ({ granted: true, ticketId: 'tk', decision });
const waiting = (): SeatAnswer => ({
  granted: false,
  ticketId: 'tk',
  reason: 'slot',
  holder: { taskId: 'other', sessionId: 's-h' },
  decision,
});

class ScriptedSeats implements SeatPort {
  answers: SeatAnswer[] = [];
  readonly calls: string[] = [];
  wakes: (() => void)[] = [];
  unsubscribed = 0;
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
  subscribe(wake: () => void): () => void {
    this.wakes.push(wake);
    return () => {
      this.unsubscribed += 1;
    };
  }
}

/** Блокирующий вопрос по шагу от его сессии (вопрос права, точка 3). */
function blocker(s: Stand, stepId: string): { sessionId: string; askId: string } {
  const sessionId = [...s.port.sessions.keys()][0]!;
  const got = raiseHumanPoint(s.task, {
    source: 'permit',
    stepId,
    sessionId,
    action: null,
    point: 3,
    dedupe: `permit:${stepId}`,
    question: 'Сливать?',
    options: ['да', 'нет'],
    recommendation: 'нет',
    blocking: true,
  });
  return { sessionId, askId: (got as { askId: string }).askId };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

async function parkedStand(seats: ScriptedSeats) {
  const s = await stand(FEATURE, { model: { 'intake:0': 'hold' }, allocator: seats });
  await s.until(() => s.port.sessions.size === 1);
  const [stepId] = Object.keys(s.task.state.steps);
  const asked = blocker(s, stepId!);
  s.port.turnEnd(stepId!);
  const parked = `release ${stepId} parked on a human ask`;
  await s.until(() => seats.calls.includes(parked));
  return { s, stepId: stepId!, parked, ...asked };
}

describe('runTask and the seat port (stage 11, P141)', () => {
  it('a session idle on an open human ask gives its seat back once; the answer takes the seat again, then goes out', async () => {
    const seats = new ScriptedSeats();
    const { s, stepId, sessionId, askId, parked } = await parkedStand(seats);
    expect(seats.calls.slice(0, 2)).toEqual([`acquire ${stepId}`, `bind ${stepId} ${sessionId}`]);
    // Повторный разбор того же конца хода места второй раз не отдаёт.
    await settle();
    expect(seats.calls.filter((c) => c === parked)).toHaveLength(1);

    await s.answer(askId, 'нет');
    await s.until(() => Object.keys(s.task.state.deliveries).length === 1);
    const after = seats.calls.slice(seats.calls.indexOf(parked) + 1);
    expect(after.slice(0, 2)).toEqual([`acquire ${stepId}`, `bind ${stepId} ${sessionId}`]);
    expect(s.port.sessions.get(sessionId)!.sends).toHaveLength(2);
    await s.stop();
  });

  it('no seat for the answer: the word waits until the port wakes the runner, then goes out', async () => {
    const seats = new ScriptedSeats();
    const { s, sessionId, askId } = await parkedStand(seats);
    seats.answers = [waiting()];
    await s.answer(askId, 'нет');
    await settle();
    expect(s.port.sessions.get(sessionId)!.sends).toHaveLength(1);
    expect(Object.keys(s.task.state.deliveries)).toHaveLength(0);

    // Место где-то освободилось: порт будит исполнителя, ждущий шаг пробует снова.
    for (const wake of seats.wakes) wake();
    await s.until(() => Object.keys(s.task.state.deliveries).length === 1);
    expect(s.port.sessions.get(sessionId)!.sends).toHaveLength(2);
    await s.stop();
  });

  it('a session that ends by itself frees its seat at once, not on a later beat', async () => {
    const seats = new ScriptedSeats();
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' }, allocator: seats });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    const session = [...s.port.sessions.values()][0]!;
    expect(seats.calls.some((c) => c.startsWith(`release ${stepId}`))).toBe(false);
    session.ended = true;
    session.on.ended();
    await s.until(() => seats.calls.includes(`release ${stepId} session ended`));
    await s.stop();
  });

  it('stopping the runner releases the held seat and unsubscribes from the port', async () => {
    const seats = new ScriptedSeats();
    const s = await stand(FEATURE, { model: { 'intake:0': 'hold' }, allocator: seats });
    await s.until(() => s.port.sessions.size === 1);
    const [stepId] = Object.keys(s.task.state.steps);
    expect(seats.wakes).toHaveLength(1);
    expect(seats.unsubscribed).toBe(0);
    await s.stop();
    expect(seats.calls.filter((c) => c.startsWith('release '))).toEqual([
      `release ${stepId} runner stopped`,
    ]);
    expect(seats.unsubscribed).toBe(1);
  });
});
