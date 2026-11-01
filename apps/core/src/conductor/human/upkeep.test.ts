import { describe, expect, it } from 'vitest';
import { deps, fakeClock, openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { seedSession, SEED_HUMAN_POLICY } from '../model-tools/__fixtures__/seed.ts';
import { ASK_REMINDER, readHumanLedger } from './ledger.ts';
import { raiseHumanPoint } from './raise.ts';
import { applyAskUpkeep, decideAskUpkeep, NONBLOCKING_EXPIRE_MS } from './upkeep.ts';

/**
 * Уход за вопросами (06 §Human points: напоминания по расписанию, вопрос — сущность с id):
 * напоминания на 15 мин / 1 ч / 4 ч, пропущенные сроки — одним напоминанием, не больше трёх;
 * неблокирующий истекает через сутки, блокирующий не истекает никогда; вопрос кончившегося шага
 * снят, вопрос без шага снят концом задачи.
 */

const MIN = 60_000;
const policy = { policy: SEED_HUMAN_POLICY };

async function setup() {
  const clock = fakeClock();
  const { task } = await openFresh(undefined, deps({ clock }));
  const s = seedSession(task, { stepKind: 'work' });
  const ask = (blocking: boolean, stepId: string | null = s.stepId) => {
    const out = raiseHumanPoint(
      task,
      {
        source: 'scenario-step',
        stepId,
        sessionId: null,
        action: null,
        point: 8,
        dedupe: newId(),
        question: 'which variant?',
        options: ['a', 'b'],
        recommendation: 'a',
        blocking,
      },
      policy,
    );
    if (out.kind !== 'asked') throw new Error(out.kind);
    return out.askId;
  };
  /** Ход часов и один проход ухода — как его зовёт крючок. */
  const tick = (ms: number, taskEnded = false) => {
    clock.advance(ms);
    const ledger = readHumanLedger(task);
    const acts = decideAskUpkeep(ledger, clock.stamp().at, taskEnded);
    applyAskUpkeep(task, ledger, acts);
    return acts;
  };
  const reminders = (askId: string) =>
    readJournalLines(task.dir, task.taskId).lines.filter(
      (l) =>
        l.kind === 'signal' &&
        (l.data as { signal: string; subject: string }).signal === ASK_REMINDER &&
        (l.data as { subject: string }).subject === askId,
    ).length;
  return { task, clock, ask, tick, reminders, ...s };
}

describe('ask upkeep', () => {
  it('reminds a blocking ask at 15 min, 1 h and 4 h, then never again; the ask never expires', async () => {
    const s = await setup();
    const askId = s.ask(true);
    expect(s.tick(14 * MIN)).toEqual([]);
    expect(s.tick(1 * MIN)).toMatchObject([{ kind: 'remind', askId, nth: 1 }]);
    expect(s.tick(1 * MIN)).toEqual([]);
    expect(s.tick(44 * MIN)).toMatchObject([{ kind: 'remind', nth: 2 }]);
    expect(s.tick(180 * MIN)).toMatchObject([{ kind: 'remind', nth: 3 }]);
    expect(s.tick(NONBLOCKING_EXPIRE_MS * 3)).toEqual([]);
    expect(s.reminders(askId)).toBe(3);
    expect(readHumanLedger(s.task).asks[askId]?.state).toBe('open');
    s.task.close();
  });

  it('catches up missed slots with one reminder, not a burst', async () => {
    const s = await setup();
    const askId = s.ask(true);
    expect(s.tick(5 * 60 * MIN)).toMatchObject([{ kind: 'remind', nth: 1 }]);
    expect(s.tick(1 * MIN)).toEqual([]);
    expect(s.reminders(askId)).toBe(1);
    s.task.close();
  });

  it('expires a non-blocking ask after 24 h', async () => {
    const s = await setup();
    const askId = s.ask(false);
    s.tick(NONBLOCKING_EXPIRE_MS - MIN);
    expect(readHumanLedger(s.task).asks[askId]?.state).toBe('open');
    expect(s.tick(MIN)).toEqual([{ kind: 'expire', askId }]);
    expect(readHumanLedger(s.task).asks[askId]?.state).toBe('expired');
    expect(s.tick(MIN)).toEqual([]);
    s.task.close();
  });

  it('withdraws the ask of an ended step, and a step-less ask only when the task ends', async () => {
    const s = await setup();
    const stepAsk = s.ask(true);
    const launchAsk = s.ask(true, null);
    const from = s.task.state.steps[s.stepId]!.state;
    s.task.append({
      kind: 'step.transition',
      actor: 'core',
      stepId: s.stepId,
      data: { stepId: s.stepId, event: 'fail', from, to: 'failed' },
    });
    expect(s.tick(0)).toMatchObject([{ kind: 'withdraw', askId: stepAsk }]);
    expect(readHumanLedger(s.task).asks[launchAsk]?.state).toBe('open');
    expect(s.tick(0, true)).toMatchObject([{ kind: 'withdraw', askId: launchAsk }]);
    const ledger = readHumanLedger(s.task);
    expect([ledger.asks[stepAsk]?.state, ledger.asks[launchAsk]?.state]).toEqual([
      'withdrawn',
      'withdrawn',
    ]);
    s.task.close();
  });

  it('keeps an ask raised after its step ended (point 6) until its unit or the task ends', async () => {
    const endStep = (s: Awaited<ReturnType<typeof setup>>) => {
      const from = s.task.state.steps[s.stepId]!.state;
      s.task.append({
        kind: 'step.transition',
        actor: 'core',
        stepId: s.stepId,
        data: { stepId: s.stepId, event: 'fail', from, to: 'failed' },
      });
    };
    // Конец единицы снимает вопрос о её следующем круге: спрашивать больше не о чем.
    const unit = await setup();
    endStep(unit);
    const unitAsk = unit.ask(true);
    expect(unit.tick(0)).toEqual([]);
    const unitId = unit.task.state.steps[unit.stepId]!.unitId;
    const from = unit.task.state.units[unitId]!.state;
    unit.task.append({
      kind: 'unit.transition',
      actor: 'core',
      unitId,
      data: { unitId, event: 'close', from, to: 'closed' },
    });
    expect(unit.tick(0)).toMatchObject([{ kind: 'withdraw', askId: unitAsk }]);
    unit.task.close();
    // Конец задачи снимает и его — задача кончилась, открытых вопросов не остаётся.
    const task = await setup();
    endStep(task);
    const taskAsk = task.ask(true);
    expect(task.tick(16 * MIN)).toMatchObject([{ kind: 'remind', askId: taskAsk }]);
    expect(task.tick(0, true)).toMatchObject([{ kind: 'withdraw', askId: taskAsk }]);
    expect(readHumanLedger(task.task).asks[taskAsk]?.state).toBe('withdrawn');
    task.task.close();
  });
});
