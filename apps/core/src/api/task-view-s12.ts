import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { MrView, TaskView, WindowWaitView } from '@agentdeck/contracts/core/task-view';
import { boardStopOf, openTakeoverOf } from '../journal/reduce/fold-view.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';

/**
 * Поля вида задачи этапа 12 (доска, карточка, лимит): остановка, перехват, MR единиц и ожидание
 * окна с вариантами перевода. Отдельно от `task-view.ts`: тот собирает виды этапов 9–11, а эти
 * поля необязательные и приходят только тогда, когда факт есть в журнале.
 */

/** Вердикты, при которых окно держит шаг; `open` и `warn` не держат. */
const HOLDING = new Set(['held', 'refused', 'exhausted', 'offline']);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

/**
 * Ожидание окна: держащее окно с самым свежим фактом и варианты из последнего решения `tier`
 * (метки — как в журнале). Не `waiting-window` или держащего окна нет — `null`.
 */
export function windowWaitOf(
  state: TaskFoldState,
  lines: readonly JournalLine[],
): WindowWaitView | null {
  if (state.task !== 'waiting-window') return null;
  const holding = Object.values(state.windows)
    .filter((w) => HOLDING.has(w.verdict))
    .sort((a, b) => b.seq - a.seq)[0];
  if (!holding) return null;
  let tier: JournalLine<'decision'> | undefined;
  for (let i = lines.length - 1; i >= 0 && !tier; i -= 1) {
    const line = lines[i];
    if (line?.kind === 'decision' && (line as JournalLine<'decision'>).data.class === 'tier')
      tier = line as JournalLine<'decision'>;
  }
  const output = (tier?.data.output ?? null) as {
    alternatives?: unknown;
    skipped?: unknown;
    offers?: unknown;
    stepId?: unknown;
  } | null;
  // Этап 12 (P169): варианты клика начатой задачи — из отказа `tier`; нет — поля нет.
  const offers = strings(output?.offers);
  return {
    // Строка ожидания окна несёт шаг в выходе (`conductor/run/windows.ts journalWaitTier`).
    stepId: tier?.stepId ?? (typeof output?.stepId === 'string' ? output.stepId : null),
    routeId: holding.routeId,
    verdict: holding.verdict,
    resetAt: holding.resetAt,
    alternatives: strings(output?.alternatives),
    skipped: strings(output?.skipped),
    ...(offers.length > 0 ? { offers } : {}),
    seq: holding.seq,
  };
}

/** MR единиц: личность из `publish.mr`, конец из `publish.mr-state`; без MR — пусто. */
export function mrsOf(state: TaskFoldState): MrView[] {
  const out: MrView[] = [];
  for (const [unitId, p] of Object.entries(state.publication)) {
    if (!p.mr) continue;
    out.push({
      unitId,
      url: p.mr.url,
      iid: p.mr.mrIid,
      ...(p.mr.title ? { title: p.mr.title } : {}),
      state: p.mrState?.state ?? 'opened',
    });
  }
  return out;
}

/** Необязательные поля этапа 12 — только те, чей факт есть (вид до 12 остаётся прежним). */
export function stage12ViewOf(
  state: TaskFoldState,
  lines: readonly JournalLine[],
): Pick<TaskView, 'windowWait' | 'stop' | 'takeover' | 'takeoverOf' | 'mrs'> {
  const stop = boardStopOf(state);
  const mrs = mrsOf(state);
  const windowWait = windowWaitOf(state, lines);
  // Чат перехвата знает свой источник: панель усыновляет его разговор по этой паре.
  const takeoverOf = state.created?.takeoverOf;
  return {
    ...(windowWait ? { windowWait } : {}),
    ...(stop ? { stop } : {}),
    ...(state.takeover !== undefined ? { takeover: openTakeoverOf(state) } : {}),
    ...(takeoverOf ? { takeoverOf: { taskId: takeoverOf.taskId, unitId: takeoverOf.unitId } } : {}),
    ...(mrs.length > 0 ? { mrs } : {}),
  };
}
