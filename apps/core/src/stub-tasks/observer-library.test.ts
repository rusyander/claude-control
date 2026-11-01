import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { SIGNAL_CATALOG, signalDef } from '../observer/catalog.ts';
import { STUB_TASKS } from './__fixtures__/library/index.ts';
import { clisOf, runStubTask, type HarnessRun } from './__fixtures__/observer-harness/index.ts';
import { formatTable, measure, type MeasuredRun } from './__fixtures__/observer-harness/measure.ts';
import type { StubTask } from './__fixtures__/stub-tasks.types.ts';

/**
 * Замер наблюдателя на всей библиотеке задач-заглушек (этап 8, P33, 06:146): каждая задача один
 * раз на каждом CLI своих протоколов идёт через стенд (`observer-harness` — настоящие рантайм
 * сессии, хук ядра, инструменты модели, журнал, краны, наблюдатель, `decideNext`; подменён
 * только процесс CLI, часы и таблица процессов). Сработавшие id — строки `signal` журнала.
 * Доля ложных на сигнал ≤ порога каталога (0, F13: ложное — дефект), каждый ожидаемый сигнал
 * выходит на своей задаче. Таблица — из этого прогона (`S8_MEASURE_OUT` — файл для отчёта).
 */

/**
 * Ожидаемые сигналы, чей писатель вне стенда ходов: истинность доказывает самопроверка каталога
 * (тест в `SignalDef.selftest`), а ложные по ним стенд считает как у всех.
 */
const OUT_OF_HARNESS = new Map<string, string>([
  ['forged-publish', 'publisher reconcile over a forge remote (phase 6), no forge in the harness'],
  ['forged-authority', 'command authority road (processCommand + peer), not a session move'],
  [
    'hook-block',
    'a user-layer hook in the CLI home refuses the call; the harness CLI has no layer',
  ],
]);

const runs: HarnessRun[] = [];
const expectedOf = new Map<string, readonly string[]>(
  STUB_TASKS.map((t) => [t.id, t.observer.signals]),
);
const measured = (list: readonly HarnessRun[], expected = expectedOf): MeasuredRun[] =>
  list.map((r) => ({
    taskId: r.taskId,
    cli: r.cli,
    expected: expected.get(r.taskId) ?? [],
    fired: r.fired,
  }));

function plan(): (readonly [StubTask, ReturnType<typeof clisOf>[number]])[] {
  return STUB_TASKS.flatMap((task) => clisOf(task.dialects).map((cli) => [task, cli] as const));
}

beforeAll(async () => {
  for (const [task, cli] of plan()) runs.push(await runStubTask(task, cli));
  const m = measure(measured(runs), SIGNAL_CATALOG, new Set(OUT_OF_HARNESS.keys()));
  const report = [
    `runs ${runs.length} (tasks ${STUB_TASKS.length})`,
    formatTable(m),
    `fp violations ${JSON.stringify(m.fpViolations)}`,
    `tp misses ${JSON.stringify(m.tpMisses)}`,
    `unknown ${JSON.stringify(m.unknown)}`,
    ...runs.map(
      (r) =>
        `run ${r.taskId}/${r.cli} fired=${JSON.stringify(r.fired)} stoppedAt=${r.stoppedAt} waitingAt=${r.waitingAt} next=${r.next} hints=${r.hintMessages} permits=${r.permits.allow}/${r.permits.deny} notes=${r.notes.length}`,
    ),
  ].join('\n');
  const out = process.env.S8_MEASURE_OUT;
  if (out) writeFileSync(out, `${report}\n`);
}, 600_000);

describe('stage 8 observer library measurement (P33, 06:146)', () => {
  it('every library task ran on every CLI of its dialects, with no tap, predicate or runtime failure', () => {
    expect(runs.length).toBe(plan().length);
    expect(runs.length).toBeGreaterThan(STUB_TASKS.length);
    expect(runs.filter((r) => r.notes.length > 0).map((r) => [r.taskId, r.cli, r.notes])).toEqual(
      [],
    );
  });

  it('every decision the library runs journal maps to a declared panel outcome (stage 9, F1)', () => {
    expect(runs.flatMap((r) => r.undeclared.map((u) => `${r.taskId}/${r.cli} ${u}`))).toEqual([]);
    // Тест проверяет решения, которые на деле записаны: без них «ни одного необъявленного» пусто.
    // Остальные классы пишет код вне стенда ходов — их судят пробы `phase2-verdicts`.
    const seen = new Set(runs.flatMap((r) => r.decisionClasses));
    expect([...seen].sort()).toEqual(['human-point', 'observer', 'permit']);
  });

  it('false-positive rate per signal stays within its catalog threshold over the whole library, and no fired id is outside the catalog', () => {
    const m = measure(measured(runs), SIGNAL_CATALOG, new Set(OUT_OF_HARNESS.keys()));
    expect(m.unknown).toEqual([]);
    expect(m.fpViolations).toEqual([]);
    for (const row of m.rows) expect(row.fpRate, row.signal).toBeLessThanOrEqual(row.fpThreshold);
  });

  it('every expected signal fires on its own task (true positives); signals written outside the harness carry a catalog selftest', () => {
    const m = measure(measured(runs), SIGNAL_CATALOG, new Set(OUT_OF_HARNESS.keys()));
    expect(m.tpMisses).toEqual([]);
    const expectedIds = new Set(STUB_TASKS.flatMap((t) => t.observer.signals));
    for (const id of OUT_OF_HARNESS.keys()) {
      expect(expectedIds.has(id), `${id} is still expected by a task`).toBe(true);
      expect(signalDef(id)?.selftest, `${id} selftest`).not.toBeNull();
    }
    // Каждая состязательная задача наблюдателя хоть что-то ждёт, и ждёт известное каталогу.
    for (const id of expectedIds) expect(signalDef(id), id).toBeDefined();
  });

  it('a stop-step signal reaches the conductor: decideNext stops the step exactly on runs whose journal holds a stop signal', () => {
    for (const r of runs) {
      const stops = r.signals.some(
        (s) => s.action === 'stop-step' || (s.action === null && s.severity === 'stop'),
      );
      expect(r.stoppedAt !== null || r.next === 'stop-step', `${r.taskId}/${r.cli}`).toBe(stops);
    }
  });

  it('every call goes through the core hook: a repeated refusal is refused twice and stops the step, a different refusal is refused once and stays silent, a clean read is never refused', () => {
    const run = (taskId: string, cli: string) =>
      runs.find((r) => r.taskId === taskId && r.cli === cli)!;
    for (const cli of ['claude', 'qwen']) {
      const repeat = run('waste-refusal-repeat', cli);
      expect(repeat.permits, `${cli} repeat`).toEqual({ allow: 0, deny: 2 });
      expect(repeat.fired).toContain('waste-refusal-repeat');
      const different = run('waste-refusal-different', cli);
      expect(different.permits.deny, `${cli} different`).toBeGreaterThan(0);
      expect(different.fired).not.toContain('waste-refusal-repeat');
      const clean = run('m-reread-adjacent-windows', cli);
      expect(clean.permits.deny, `${cli} clean`).toBe(0);
      expect(clean.permits.allow).toBeGreaterThan(0);
    }
  });

  it('a grantRequired edit is refused once through the core hook and the step waits for the human (point 5): no refusal repeat, no signal', () => {
    for (const r of runs.filter((x) => x.taskId === 'stage4-grant-required-edit')) {
      expect(r.permits, r.cli).toEqual({ allow: 0, deny: 1 });
      expect(r.waitingAt, r.cli).toBe(0);
      expect(r.kinds, r.cli).toContain('human.asked');
      expect(r.fired, r.cli).toEqual([]);
    }
    expect(runs.filter((x) => x.taskId === 'stage4-grant-required-edit').length).toBeGreaterThan(0);
  });

  it('integrity facts reach the journal through the economy tap and the lease release: the clean step writes usage, window and a verified lease without a signal, each adversarial twin fires its own', () => {
    const of = (taskId: string) => runs.filter((r) => r.taskId === taskId);
    for (const r of of('integrity-clean-step')) {
      expect(r.kinds, r.cli).toEqual(
        expect.arrayContaining(['turn.usage', 'window.state', 'resource.verified']),
      );
      expect(r.kinds, r.cli).not.toContain('resource.leak');
      expect(r.fired, r.cli).toEqual([]);
    }
    for (const r of of('integrity-leaked-lease')) expect(r.fired, r.cli).toEqual(['resource-leak']);
    for (const r of of('integrity-window-refusal')) {
      expect(
        r.signals.filter((s) => s.signal === 'window').map((s) => s.severity),
        r.cli,
      ).toEqual(['info', 'warn']);
    }
    for (const r of [...of('integrity-context-ramp'), ...of('integrity-context-ramp-reported')]) {
      expect(
        r.signals.filter((s) => s.signal === 'context-growth'),
        `${r.taskId}/${r.cli}`,
      ).toHaveLength(1);
    }
    // Почти-двойник по названному окну: 55 % — ни одного сигнала.
    for (const r of of('integrity-context-reported-55')) expect(r.fired, r.cli).toEqual([]);
    expect(of('integrity-clean-step').length).toBeGreaterThan(0);
    expect(of('integrity-context-ramp-reported').length).toBeGreaterThan(0);
    expect(of('integrity-context-reported-55').length).toBeGreaterThan(0);
  });

  it('the measurement goes red on real runs: an adversarial task with its expectation stripped counts a false positive, a near-miss with one added counts a missed true positive', () => {
    const adversarial = runs.find((r) => r.taskId === 'reread-loop' && r.cli === 'claude');
    const nearMiss = runs.find((r) => r.taskId === 'waste-reread-after-edit' && r.cli === 'claude');
    expect(adversarial?.fired).toContain('waste-reread');
    expect(nearMiss?.fired).not.toContain('waste-reread');
    const stripped = new Map(expectedOf).set('reread-loop', []);
    const added = new Map(expectedOf).set('waste-reread-after-edit', ['waste-reread']);
    const fp = measure(measured([adversarial!], stripped), SIGNAL_CATALOG);
    expect(fp.fpViolations).toEqual([
      { signal: 'waste-reread', taskId: 'reread-loop', cli: 'claude' },
    ]);
    const tp = measure(measured([nearMiss!], added), SIGNAL_CATALOG);
    expect(tp.tpMisses).toEqual([
      { signal: 'waste-reread', taskId: 'waste-reread-after-edit', cli: 'claude' },
    ]);
  });
});
