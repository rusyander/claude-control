import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/index.ts';
import { stand, attempts, type Stand } from '../../conductor/run/__fixtures__/run-harness.ts';
import { presetStep } from '../../conductor/scenario/presets.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { createLivenessProbe, fakeProcessTable } from '../../platform/process-identity.ts';
import { createActivityBook } from './activity.ts';
import { attachObserver } from './attach.ts';
import { createStallWatch } from './stall.ts';

/**
 * Тишина сессии поверх настоящего исполнителя дирижёра (стенд `run-harness`: настоящий журнал,
 * `decideNext`, исполнитель; подделана только сессия модели — «держит» шаг, ничего не пишет) и
 * настоящего наблюдателя: сигнал `stall` по живой молчащей сессии шаг не снимает и сессию не
 * останавливает; мёртвый хост — сессия `lost`, исполнитель видит конец сессии.
 */

const MIN = 60_000;

function single(): Scenario {
  const step = presetStep('work', 'work', 'Работа', []);
  return { id: 'stall-work', version: 1, title: 't', steps: [step] };
}

const TURN: AdapterEvent = { type: 'turn.started', attribution: 'a', origin: 'sequence' };

async function wired(s: Stand) {
  await s.until((t) => Object.values(t.state.sessions).some((x) => x.state === 'live'));
  const [sessionId, session] = Object.entries(s.task.state.sessions)[0]!;
  const at = { t: 0 };
  const now = () => at.t;
  const notes: string[] = [];
  const note = (e: string) => notes.push(e);
  attachObserver(s.task, { ctx: { windowOf: () => null, now }, note });
  const book = createActivityBook({ now, note });
  const table = fakeProcessTable([
    { pid: session.hostPid, ppid: 1, start: session.hostStart, startMs: 1, cpuMs: 10 },
  ]);
  const stopped: string[] = [];
  const watch = createStallWatch({
    activity: book,
    now,
    probe: createLivenessProbe(table, 0, now),
    // Снятое дерево: дорога сессии видит конец потока и говорит исполнителю `ended`.
    stop: async (_t, sid) => {
      stopped.push(sid);
      s.port.sessions.get(sid)?.on.ended();
    },
    note,
    options: { stallDefaultMs: 10 * MIN },
  });
  watch.attach(s.task);
  const unitId = s.task.state.steps[session.stepId]!.unitId;
  book.tap.onEvent(
    s.task,
    { taskId: s.taskId, sessionId, stepId: session.stepId, unitId, stepKind: 'work' },
    TURN,
    { inHistory: false },
  );
  const tickAt = async (t: number) => {
    at.t = t;
    await watch.tick();
  };
  return { sessionId, stepId: session.stepId, table, stopped, notes, tickAt };
}

const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;

describe('stage 8 stall over the real conductor run (F9, P18)', () => {
  it('stage 8 stall run alive: a held step whose session went quiet past the threshold gets one stall signal; the step keeps running and no session is ended', async () => {
    const s = await stand(single(), { model: { 'work:0': 'hold' }, journalSessions: true });
    const w = await wired(s);
    await w.tickAt(MIN);
    await w.tickAt(10 * MIN);
    const signals = lines(s).filter(
      (l) => l.kind === 'signal' && (l as JournalLine<'signal'>).data.signal === 'stall',
    );
    expect(signals).toHaveLength(1);
    expect(s.task.state.steps[w.stepId]?.state).toBe('running');
    expect(s.task.state.sessions[w.sessionId]?.state).toBe('quiet');
    expect(s.port.ends).toEqual([]);
    expect(w.stopped).toEqual([]);
    expect(w.notes).toEqual([]);
    await s.stop();
  });

  it('stage 8 stall run dead host: the session is lost, its tree stopped, and the conductor takes the step on by its own rule', async () => {
    const s = await stand(single(), { model: { 'work:0': 'hold' }, journalSessions: true });
    const w = await wired(s);
    await w.tickAt(MIN);
    w.table.set([]);
    await w.tickAt(10 * MIN);
    expect(w.stopped).toEqual([w.sessionId]);
    expect(s.task.state.sessions[w.sessionId]?.state).toBe('lost');
    // Конец сессии без заявления — правило дирижёра: попытка выведена провалом, следующий круг
    // шага получает НОВУЮ сессию (стенд на круге 1 заявляет «готово»).
    await s.until((t) => attempts(t).includes('work:1:done:claimed'));
    expect(attempts(s.task)).toEqual(['work:0:failed:derived', 'work:1:done:claimed']);
    expect(s.port.opened).toHaveLength(2);
    const states = Object.entries(s.task.state.sessions).map(([id, x]) => [
      id === w.sessionId,
      x.state,
    ]);
    expect(states).toEqual([
      [true, 'lost'],
      [false, 'ended'],
    ]);
    expect(s.port.ends.map((e) => e.sessionId)).not.toContain(w.sessionId);
    await s.stop();
  });
});
