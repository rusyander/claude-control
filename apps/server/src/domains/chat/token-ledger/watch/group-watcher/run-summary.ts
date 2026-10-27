import { GROUP_WATCH_SEVERITY } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../../lib/app-store/app-store.types.ts';
import type { WastePoint } from '../group-ledgers.ts';
import type { BurnPoint } from '../rules.ts';
import { minutes } from '../rules-util.ts';
import type { RuleHit, WatchEvent, WatchState } from '../watch.types.ts';
import type { FinishedRun } from './window-rules.ts';

/**
 * R46 «итог прогона» (сведение): у каждого законченного прогона группы — токены, минуты,
 * сдвиг окон и доля, ушедшая впустую. Доля — по весу вызовов: вызов разговора, за которым
 * повтор (проверка без правки, перечитывание, тот же сбой, сон — проверка) или отказ
 * стража, — впустую целиком; прогон после напоминания о доставке — переделка целиком.
 * Перенос `RUN`-строки внешнего сторожа, но о каждом прогоне, а не только о тяжёлом (R42).
 */

const pct = (share: number): number => Math.round(Math.min(1, Math.max(0, share)) * 100);

/**
 * Шаг впустую в свёрнутом событии разговора: свёртка уже учла событие, так что повтор —
 * запись с отметкой этого же времени и счётом от двух. Шаги субагента свёртка в эти
 * списки не пишет (`onSidechainTool`) — они сюда не попадают.
 */
export function wasteStep(state: WatchState, event: WatchEvent): WastePoint['kind'] | undefined {
  if (event.kind === 'tool') {
    const again = (lastAt: number, count: number): boolean => lastAt === event.t && count >= 2;
    if (state.sleepPolls.at(-1)?.at === event.t) return 'repeat';
    if (Object.values(state.checks).some((check) => again(check.lastAt, check.runs))) {
      return 'repeat';
    }
    if (Object.values(state.reads).some((read) => again(read.lastAt, read.count))) return 'repeat';
    return undefined;
  }
  if (event.kind !== 'toolResult') return undefined;
  if (event.denied && state.denials.at(-1)?.at === event.t) return 'denied';
  const failedAgain = Object.values(state.errors).some(
    (run) => run.lastAt === event.t && run.ats.length >= 2,
  );
  return failedAgain ? 'repeat' : undefined;
}

export interface RunSummaryInput {
  /** Законченные прогоны группы за полчаса. */
  runs: readonly FinishedRun[];
  /** Расход группы (все вызовы) и вызовы впустую — списки сторожа. */
  burn: readonly BurnPoint[];
  waste: readonly WastePoint[];
  group: Pick<SplitPlanGroupRecord, 'deliveryHistory' | 'deliveryNudges'>;
}

/**
 * R46 группы: последний её законченный прогон. Окна не мерились — строка без них; вызовов
 * прогона сторож не видел (панель перезапускалась) и переделкой он не был — без доли.
 */
export function runSummaryHit(input: RunSummaryInput): RuleHit | undefined {
  const last = input.runs.reduce<FinishedRun | undefined>(
    (max, run) => (!max || run.endedAt > max.endedAt ? run : max),
    undefined,
  );
  if (!last) return undefined;
  const inRun = (t: number): boolean => t >= last.startedAt && t <= last.endedAt;
  const burn = input.burn.reduce((sum, point) => sum + (inRun(point.t) ? point.weight : 0), 0);
  const wasted = (kind: WastePoint['kind']): number =>
    input.waste.reduce(
      (sum, point) => sum + (point.kind === kind && inRun(point.t) ? point.weight : 0),
      0,
    );
  const repeat = burn > 0 ? wasted('repeat') / burn : 0;
  const denied = burn > 0 ? wasted('denied') / burn : 0;
  const rework =
    (input.group.deliveryNudges ?? 0) > 0 &&
    (input.group.deliveryHistory ?? []).some((round) => Date.parse(round.at) <= last.startedAt);
  const windows = last.five !== undefined || last.seven !== undefined;
  const measured = rework || burn > 0;
  return {
    rule: 'R46',
    severity: GROUP_WATCH_SEVERITY.R46,
    numbers: {
      mTokens: Math.round(last.tokens / 100_000) / 10,
      runMin: Math.max(1, minutes(last.endedAt - last.startedAt)),
      ...(windows ? { fivePct: pct(last.five ?? 0), weekPct: pct(last.seven ?? 0) } : {}),
      ...(measured
        ? {
            wastePct: rework ? 100 : pct(repeat + denied),
            reworkPct: rework ? 100 : 0,
            repeatPct: pct(repeat),
            deniedPct: pct(denied),
          }
        : {}),
    },
    since: last.endedAt,
    textKey: `groupWatch.rule.${windows ? 'R46' : 'R46tokens'}${measured ? '' : 'Bare'}`,
  };
}
