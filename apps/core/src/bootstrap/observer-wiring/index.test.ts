import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../../adapters/adapter.types.ts';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { seedSession } from '../../conductor/model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../../conductor/model-tools/binding.ts';
import { openFresh } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import { createLivenessProbe, fakeProcessTable } from '../../platform/process-identity.ts';
import { createObserverWiring } from './index.ts';

/**
 * Проводка наблюдателя ядра целиком (этап 8, закрытие): один кран пишет факты вызовов И кормит
 * книгу активности; класс ожидаемого вызова — сопоставление переходника сессии, выученный p95
 * этого класса — порог сторожа тишины; вопрос права, который ядро ещё решает, тишиной не
 * считается; отказ писателя — сигнал `journal-rejected` прикреплённой задачи; `stop` снимает всё.
 * Настоящие журнал, свёртка, наблюдатель, сторож и кран; подделаны часы и таблица процессов.
 */

const MIN = 60_000;
const P95_EXEC = MIN;

const ev = {
  turn: { type: 'turn.started', attribution: 'a', origin: 'sequence' } as AdapterEvent,
  bash: (id: string, command: string): AdapterEvent => ({
    type: 'tool.requested',
    toolUseId: id,
    name: 'Bash',
    input: { command },
    cliInitiated: false,
  }),
  done: (id: string): AdapterEvent => ({
    type: 'tool.result',
    toolUseId: id,
    isError: false,
    cliInitiated: false,
    outcome: { exitCode: 0, errorText: null, bytes: null },
  }),
};

async function wiredTask(over: { sessionOf?: boolean } = {}) {
  const { task } = await openFresh();
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const at = { t: 0 };
  const notes: string[] = [];
  const deciding = { now: false };
  const session = task.state.sessions[seeded.sessionId]!;
  const table = fakeProcessTable([
    { pid: session.hostPid, ppid: 1, start: session.hostStart, startMs: 1, cpuMs: 10 },
  ]);
  const wiring = createObserverWiring({
    note: (e) => notes.push(e),
    now: () => at.t,
    options: {
      probe: createLivenessProbe(table, 0, () => at.t),
      silentAfterMs: 1_000,
      stallDefaultMs: 30 * MIN,
    },
    ...(over.sessionOf === false
      ? {}
      : { sessionOf: () => ({ mapPermission: mapClaudePermission, cwd: '/w' }) }),
    toolP95: () => ({ exec: P95_EXEC }),
    permitPending: () => deciding.now,
    tickEveryMs: 0,
  });
  wiring.attach(task);
  const feed = (e: AdapterEvent) =>
    wiring.tap.onEvent(task, bound.binding, e, { inHistory: false });
  const lines = (): JournalLine[] => readJournalLines(task.dir, task.taskId).lines;
  const tickAt = async (t: number) => {
    at.t = t;
    await wiring.tick();
  };
  return { task, seeded, wiring, feed, lines, tickAt, deciding, notes, at };
}

describe('observer wiring: taps, stall watch and rejected sink composed as the core boots them', () => {
  it('one tap writes the call fact AND feeds activity: a finished Bash is one tool.event of class exec', async () => {
    const w = await wiredTask();
    w.feed(ev.turn);
    w.feed(ev.bash('t1', 'npm test'));
    w.at.t = 500;
    w.feed(ev.done('t1'));
    const facts = w.lines().filter((l) => l.kind === 'tool.event');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.data).toMatchObject({ toolUseId: 't1', tool: 'Bash', effectClass: 'exec' });
    expect(w.notes).not.toContain('observer.tap.failed');
    w.wiring.stop();
    w.task.close();
  });

  it('stall: a pending exec call is judged by the learned exec p95 (x3, floor 2 min); a question the core still decides is not silence', async () => {
    const w = await wiredTask();
    w.feed(ev.turn);
    w.feed(ev.bash('t1', 'npm run build'));
    w.deciding.now = true;
    await w.tickAt(5_000);
    expect(w.task.state.sessions[w.seeded.sessionId]?.state).toBe('live');
    w.deciding.now = false;
    await w.tickAt(5_001);
    expect(w.task.state.sessions[w.seeded.sessionId]?.state).toBe('quiet');
    // Ниже порога выученного exec (3 мин) пробы нет; на пороге — одна, с классом и основанием.
    await w.tickAt(3 * P95_EXEC - 1);
    expect(w.lines().filter((l) => l.kind === 'session.probe')).toEqual([]);
    await w.tickAt(3 * P95_EXEC);
    const probes = w.lines().filter((l) => l.kind === 'session.probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]!.data).toMatchObject({
      verdict: 'alive',
      toolClass: 'exec',
      thresholdMs: 3 * P95_EXEC,
    });
    w.wiring.stop();
    w.task.close();
  });

  it('near-miss: without the session mapping the pending call is the generic tool class — no learned p95, the default threshold rules', async () => {
    const w = await wiredTask({ sessionOf: false });
    w.feed(ev.turn);
    w.feed(ev.bash('t1', 'npm run build'));
    await w.tickAt(5_000);
    await w.tickAt(3 * P95_EXEC);
    expect(w.lines().filter((l) => l.kind === 'session.probe')).toEqual([]);
    expect(w.lines().filter((l) => l.kind === 'tool.event')).toEqual([]);
    await w.tickAt(30 * MIN);
    const probes = w.lines().filter((l) => l.kind === 'session.probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]!.data).toMatchObject({ toolClass: 'tool', thresholdMs: 30 * MIN });
    w.wiring.stop();
    w.task.close();
  });

  it('rejected sink: a writer refusal on an attached task is a journal-rejected signal; on a task not attached only a note', async () => {
    const w = await wiredTask();
    w.wiring.rejected(w.task.taskId, { kind: 'schema', issues: ['data.x: unknown field'] });
    const signals = w
      .lines()
      .filter(
        (l) => l.kind === 'signal' && (l.data as { signal: string }).signal === 'journal-rejected',
      );
    expect(signals).toHaveLength(1);
    const before = w.lines().length;
    w.wiring.rejected('not-attached', { kind: 'schema', issues: ['x'] });
    expect(w.lines()).toHaveLength(before);
    w.wiring.stop();
    w.task.close();
  });

  it('stop detaches the observer and the stall watch: later quiet and refusals write nothing', async () => {
    const w = await wiredTask();
    w.feed(ev.turn);
    w.wiring.stop();
    const before = w.lines().length;
    await w.tickAt(60 * MIN);
    w.wiring.rejected(w.task.taskId, { kind: 'schema', issues: ['x'] });
    expect(w.lines()).toHaveLength(before);
    w.task.close();
  });
});
