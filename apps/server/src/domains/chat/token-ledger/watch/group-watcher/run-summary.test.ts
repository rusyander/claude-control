import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { WastePoint } from '../group-ledgers.ts';
import { createWatchState, reduce } from '../reduce.ts';
import type { BurnPoint } from '../rules.ts';
import type { WatchContext, WatchEvent } from '../watch.types.ts';
import { runSummaryHit, wasteStep } from './run-summary.ts';
import type { FinishedRun } from './window-rules.ts';

const T0 = Date.parse('2026-10-27T10:00:00Z');
const MIN = 60_000;

/** Шаги впустую на свёрнутом потоке: свёртка, потом `wasteStep` — как в `apply()` сторожа. */
function steps(events: WatchEvent[]): Array<WastePoint['kind'] | undefined> {
  const ctx: WatchContext = { settings: GROUP_WATCH_DEFAULTS };
  const state = createWatchState(T0);
  return events.map((event) => {
    reduce(state, event, ctx);
    return wasteStep(state, event);
  });
}

const bash = (t: number, command: string, sidechain?: boolean): WatchEvent => ({
  kind: 'tool',
  t,
  id: `b${t}`,
  name: 'Bash',
  input: { command },
  ...(sidechain ? { sidechain } : {}),
});
const read = (t: number, path: string, sidechain?: boolean): WatchEvent => ({
  kind: 'tool',
  t,
  id: `r${t}`,
  name: 'Read',
  input: { file_path: path },
  ...(sidechain ? { sidechain } : {}),
});
const edit = (t: number, path: string): WatchEvent => ({
  kind: 'tool',
  t,
  id: `e${t}`,
  name: 'Edit',
  input: { file_path: path, old_string: 'a', new_string: 'b' },
});
const result = (
  of: WatchEvent,
  over: Partial<Extract<WatchEvent, { kind: 'toolResult' }>> = {},
): WatchEvent => ({
  kind: 'toolResult',
  t: of.t + 1000,
  id: (of as { id: string }).id,
  chars: 40,
  ...over,
});

describe('R46 — шаг впустую в потоке разговора', () => {
  it('второй прогон той же проверки без правки — повтор; после правки — нет', () => {
    const first = bash(T0, 'pnpm test');
    const again = bash(T0 + MIN, 'pnpm test');
    const fixed = edit(T0 + 2 * MIN, 'src/a.ts');
    const after = bash(T0 + 3 * MIN, 'pnpm test');
    expect(steps([first, result(first), again, result(again), fixed, after])).toEqual([
      undefined,
      undefined,
      'repeat',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('второе чтение того же файла — повтор; другой файл — нет', () => {
    expect(
      steps([read(T0, 'src/a.ts'), read(T0 + MIN, 'src/b.ts'), read(T0 + 2 * MIN, 'src/a.ts')]),
    ).toEqual([undefined, undefined, 'repeat']);
  });

  it('сон-проверка — повтор с первого раза; простой `sleep` — нет', () => {
    expect(
      steps([
        bash(T0, 'sleep 5'),
        bash(T0 + MIN, 'while ! grep -q done out.log; do sleep 30; done'),
      ]),
    ).toEqual([undefined, 'repeat']);
  });

  it('тот же сбой вторым разом — повтор; первый сбой — нет', () => {
    const fail = (t: number): WatchEvent[] => {
      const call = bash(t, 'curl -s http://127.0.0.1:5178/api/x');
      return [
        call,
        result(call, {
          isError: true,
          errorKind: 'exit',
          errorHead: 'curl: (7) Failed to connect',
        }),
      ];
    };
    expect(steps([...fail(T0), ...fail(T0 + MIN)])).toEqual([
      undefined,
      undefined,
      undefined,
      'repeat',
    ]);
  });

  it('отказ стража — отказ; ответ без отказа — ничего', () => {
    const push = bash(T0, 'git push origin main');
    const ls = bash(T0 + MIN, 'ls');
    expect(steps([push, result(push, { denied: 'git-guard' }), ls, result(ls)])).toEqual([
      undefined,
      'denied',
      undefined,
      undefined,
    ]);
  });

  it('шаг субагента не в счёт разговора', () => {
    expect(steps([read(T0, 'src/a.ts'), read(T0 + MIN, 'src/a.ts', true)])).toEqual([
      undefined,
      undefined,
    ]);
  });
});

const run = (over: Partial<FinishedRun> = {}): FinishedRun => ({
  id: 'r1',
  chatId: 'c1',
  startedAt: T0,
  endedAt: T0 + 10 * MIN,
  tokens: 2_340_000,
  ...over,
});
const burn: BurnPoint[] = [
  { t: T0 + MIN, weight: 60 },
  { t: T0 + 2 * MIN, weight: 30 },
  { t: T0 + 3 * MIN, weight: 10 },
  // Вне прогона — не в его счёт.
  { t: T0 + 20 * MIN, weight: 1_000 },
];
const waste: WastePoint[] = [
  { t: T0 + 2 * MIN, weight: 30, kind: 'repeat' },
  { t: T0 + 3 * MIN, weight: 10, kind: 'denied' },
  { t: T0 + 20 * MIN, weight: 1_000, kind: 'repeat' },
];
const quiet = { deliveryNudges: 0, deliveryHistory: [] };

describe('R46 — итог прогона', () => {
  it('окна, токены и доля впустую по весу вызовов прогона', () => {
    const hit = runSummaryHit({
      runs: [run({ five: 0.12, seven: 0.031 })],
      burn,
      waste,
      group: quiet,
    });
    expect(hit).toEqual({
      rule: 'R46',
      severity: 'info',
      numbers: {
        mTokens: 2.3,
        runMin: 10,
        fivePct: 12,
        weekPct: 3,
        wastePct: 40,
        reworkPct: 0,
        repeatPct: 30,
        deniedPct: 10,
      },
      since: T0 + 10 * MIN,
      textKey: 'groupWatch.rule.R46',
    });
  });

  it('итог — о последнем законченном прогоне', () => {
    const later = run({
      id: 'r2',
      startedAt: T0 + 15 * MIN,
      endedAt: T0 + 25 * MIN,
      tokens: 500_000,
    });
    const hit = runSummaryHit({ runs: [later, run()], burn, waste, group: quiet });
    expect(hit?.since).toBe(T0 + 25 * MIN);
    expect(hit?.numbers).toMatchObject({ mTokens: 0.5, wastePct: 100, repeatPct: 100 });
  });

  it('прогон после круга доставки с напоминанием — переделка целиком', () => {
    const group = {
      deliveryNudges: 1,
      deliveryHistory: [{ at: new Date(T0 - MIN).toISOString(), missing: ['mr'] }],
    };
    const hit = runSummaryHit({ runs: [run()], burn: [], waste: [], group });
    expect(hit?.textKey).toBe('groupWatch.rule.R46tokens');
    expect(hit?.numbers).toMatchObject({ wastePct: 100, reworkPct: 100, repeatPct: 0 });
  });

  it('круг доставки после старта прогона или без напоминания — не переделка', () => {
    const after = {
      deliveryNudges: 1,
      deliveryHistory: [{ at: new Date(T0 + MIN).toISOString(), missing: ['mr'] }],
    };
    const unnudged = { ...after, deliveryNudges: 0 };
    unnudged.deliveryHistory = [{ at: new Date(T0 - MIN).toISOString(), missing: ['mr'] }];
    for (const group of [after, unnudged]) {
      const hit = runSummaryHit({ runs: [run()], burn, waste, group });
      expect(hit?.numbers).toMatchObject({ wastePct: 40, reworkPct: 0 });
    }
  });

  it('вызовов прогона сторож не видел — строка без доли; окна мерились — с окнами', () => {
    const bare = runSummaryHit({ runs: [run()], burn: [], waste: [], group: quiet });
    expect(bare?.textKey).toBe('groupWatch.rule.R46tokensBare');
    expect(bare?.numbers).toEqual({ mTokens: 2.3, runMin: 10 });
    const windows = runSummaryHit({
      runs: [run({ seven: 0.02 })],
      burn: [],
      waste: [],
      group: quiet,
    });
    expect(windows?.textKey).toBe('groupWatch.rule.R46Bare');
    expect(windows?.numbers).toEqual({ mTokens: 2.3, runMin: 10, fivePct: 0, weekPct: 2 });
  });

  it('законченных прогонов нет — молчит; прогон короче минуты — минута', () => {
    expect(runSummaryHit({ runs: [], burn, waste, group: quiet })).toBeUndefined();
    const short = runSummaryHit({
      runs: [run({ endedAt: T0 + 10_000 })],
      burn: [],
      waste: [],
      group: quiet,
    });
    expect(short?.numbers.runMin).toBe(1);
  });
});
