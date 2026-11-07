import { describe, expect, it } from 'vitest';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import { raiseHumanPoint } from '../human/raise.ts';
import {
  CREATED,
  deps as journalDeps,
  fakeClock,
  openFresh,
} from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { newId } from '../../lib/ids/uuidv7.ts';
import { FakePort, ROUTE, scriptedHooks } from '../run/__fixtures__/run-harness.ts';
import { runTask } from '../run/run.ts';
import type { SeatAnswer, SeatAsk, SeatPort } from '../schedule/schedule.types.ts';
import { presetOf } from '../scenario/presets.ts';

/**
 * Запасной путь «по одному» (этап 11, W3-18, P145): тот же план из двух параллельных единиц на
 * одном месте сеанса (как `local:own` — маршрут держит одну сессию) и на двух местах. Настоящие
 * исполнитель, `decideNext`, журнал и места через порт распределителя; подделаны сессия модели и
 * вердикты крючков. Сравнение нормализовано: по единице — последовательность шагов, вердикты
 * сдачи и записи проверок равны; разнится только одновременность.
 */

const FEATURE = presetOf({ id: 'feature', version: 1 })!;

/** Распределитель на `slots` мест: сверх — ждать, держатель назван; пик одновременности пишется. */
class CountingSeats implements SeatPort {
  private readonly held = new Set<string>();
  private readonly wakes = new Set<() => void>();
  peak = 0;
  waits = 0;
  private readonly slots: number;
  constructor(slots: number) {
    this.slots = slots;
  }
  acquire(ask: SeatAsk): Promise<SeatAnswer> {
    const decision = { order: [], grant: [], reasons: [] };
    if (this.held.has(ask.stepId) || this.held.size < this.slots) {
      this.held.add(ask.stepId);
      this.peak = Math.max(this.peak, this.held.size);
      return Promise.resolve({ granted: true, ticketId: ask.stepId, decision });
    }
    this.waits += 1;
    return Promise.resolve({
      granted: false,
      ticketId: ask.stepId,
      reason: `${this.slots} seat(s) busy`,
      holder: { taskId: ask.taskId, sessionId: null },
      decision,
    });
  }
  bind(): void {}
  release(_taskId: string, stepId: string): void {
    if (!this.held.delete(stepId)) return;
    for (const wake of this.wakes) wake();
  }
  subscribe(wake: () => void): () => void {
    this.wakes.add(wake);
    return () => this.wakes.delete(wake);
  }
}

interface Ran {
  task: LiveTask;
  seats: CountingSeats;
  units: [string, string];
  lines: JournalLine[];
}

async function runPlan(slots: number): Promise<Ran> {
  const clock = fakeClock();
  const d = journalDeps({ clock, now: () => clock.stamp().at });
  const { task, taskId } = await openFresh(undefined, d);
  task.append({
    kind: 'task.created',
    actor: 'core',
    data: {
      ...CREATED,
      scenario: { id: FEATURE.id, version: FEATURE.version },
      allowedRoutes: [ROUTE],
    },
  });
  const splitId = newId();
  const units = [newId(), newId()] as [string, string];
  for (const [i, unitId] of units.entries())
    task.append({
      kind: 'unit.created',
      actor: 'core',
      unitId,
      data: {
        unitId,
        name: i === 0 ? 'api' : 'web',
        repoKey: 'r1',
        branch: `agentdeck/${unitId.slice(-8)}`,
        ownedPaths: [i === 0 ? 'src/api/**' : 'src/web/**'],
        after: [],
        contract: false,
        splitId,
      },
    });
  task.append({
    kind: 'task.transition',
    actor: 'core',
    data: { taskId, event: 'launch', from: 'draft', to: 'running' },
  });
  const script = {};
  const port = new FakePort(script);
  port.task = task;
  const seats = new CountingSeats(slots);
  const run = runTask(task, {
    hooks: [scriptedHooks(script, [])],
    scenarioOf: (ref) => (ref.id === FEATURE.id ? FEATURE : undefined),
    sessions: port,
    raise: (r) => raiseHumanPoint(task, r),
    now: () => clock.stamp().at,
    allocator: seats,
  });
  await run.idle();
  await run.stop();
  const lines = readJournalLines(task.dir, taskId).lines;
  task.close();
  return { task, seats, units, lines };
}

/** По единице: `<def>:<round>:<state>:<basis>` в порядке начала шагов. */
function stepsOf(r: Ran, unitId: string): string[] {
  return Object.values(r.task.state.steps)
    .filter((s) => s.unitId === unitId)
    .sort((a, b) => a.startedSeq - b.startedSeq)
    .map((s) => `${s.stepDefId}:${s.round}:${s.state}:${s.basis ?? '-'}`);
}

const stepDef = (r: Ran) =>
  new Map(Object.entries(r.task.state.steps).map(([id, s]) => [id, s.stepDefId]));

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** По единице: вердикты сдачи и проверок — без id, времени и порядка строк между единицами. */
function recordsOf(r: Ran, unitId: string): string[] {
  const defs = stepDef(r);
  const out: string[] = [];
  for (const l of r.lines) {
    if (l.unitId !== unitId && !(l.stepId && r.task.state.steps[l.stepId]?.unitId === unitId))
      continue;
    const data = l.data as Record<string, unknown>;
    const def = l.stepId ? defs.get(l.stepId) : undefined;
    if (l.kind === 'step.claimed') out.push(`claimed:${def}:${String(data.outcome ?? '-')}`);
    else if (l.kind === 'step.ended')
      out.push(`ended:${def}:${String(data.reason ?? '').replace(UUID, '<id>')}`);
    // Записи проверок (стенд судит крючками — их вердикт в причине `step.ended`; прогоны, если есть).
    else if (l.kind === 'check.requested')
      out.push(`check:${def}:${String(data.checkId)}:${String(data.grade)}`);
    // `schedule` — ожидание места: единственная разница одного места и двух, её не сравнивают.
    else if (l.kind === 'decision' && data.class !== 'schedule')
      out.push(`decision:${String(data.class)}:${def ?? '-'}`);
  }
  return out;
}

describe('W3-18 fallback serial = the same plan one at a time (P145)', () => {
  it('two parallel units on 1 seat vs 2 seats: per-unit step sequence, verdicts and check records equal; only concurrency differs', async () => {
    const serial = await runPlan(1);
    const parallel = await runPlan(2);
    // Одно место — сеансы строго по одному, второй ждал; два — шли вместе.
    expect(serial.seats.peak).toBe(1);
    expect(serial.seats.waits).toBeGreaterThan(0);
    expect(parallel.seats.peak).toBe(2);
    for (const r of [serial, parallel]) {
      expect(r.task.state.task).toBe('done');
      expect(Object.values(r.task.state.units).map((u) => u.state)).toEqual(['done', 'done']);
    }
    for (const i of [0, 1] as const) {
      const s = stepsOf(serial, serial.units[i]);
      expect(s).toContain('review:0:done:claimed');
      expect(s).toEqual(stepsOf(parallel, parallel.units[i]));
      expect(recordsOf(serial, serial.units[i])).toEqual(recordsOf(parallel, parallel.units[i]));
      expect(recordsOf(serial, serial.units[i]).length).toBeGreaterThan(0);
    }
  }, 60_000);
});
