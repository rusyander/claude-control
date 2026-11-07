import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate } from '../observer.types.ts';

export const SPEND_OVER_ESTIMATE_SIGNAL = 'spend-over-estimate';

/** Во сколько раз расход выше верхней границы оценки, чтобы о нём сказать (F3). */
export const SPEND_OVER_FACTOR = 2;

/** Строка оценки запуска (`conductor/estimate`): числа истории JSON-деталью сигнала. */
const ESTIMATE_HISTORY = 'estimate-history';

export interface SpendOverFold {
  /** Верхняя граница оценки (p90 истории, без разброса — сама оценка); `null` — судить не с чем. */
  readonly upper: number | null;
  /** Токены бюджета по сообщениям (`sessionId|messageId`): повтор строки заменяет, не прибавляет. */
  readonly usage: Readonly<Record<string, number>>;
  readonly spent: number;
  readonly steps: Readonly<Record<string, string>>;
  readonly done: boolean;
}

/** Верхняя граница из детали оценки; основание `no-history` или нечитаемая деталь — `null`. */
export function estimateUpper(detail: string): number | null {
  try {
    const v = JSON.parse(detail) as {
      basis?: unknown;
      tokens?: unknown;
      spread?: unknown;
    };
    if (v.basis !== 'history') return null;
    const top = Array.isArray(v.spread) ? v.spread[1] : v.tokens;
    return typeof top === 'number' && top > 0 ? top : null;
  } catch {
    return null;
  }
}

/**
 * Расход сверх оценки (этап 11, F3, P143): потолка расхода у задачи нет, и вопроса тоже — это
 * заметка в ленте. Расход задачи (токены бюджета: вход + запись кэша + выход — та же мера, что у
 * истории, из которой оценка) перевалил за `SPEND_OVER_FACTOR` × верхнюю границу оценки запуска —
 * один сигнал за жизнь задачи; каталог даёт ему `info` + `show`: ничего не останавливается и не
 * спрашивается. Оценка без истории (`no-history`) — молчит: числа нет, судить не с чем.
 */
export const spendOverEstimate: Predicate<SpendOverFold> = {
  ids: [SPEND_OVER_ESTIMATE_SIGNAL],
  init: () => ({ upper: null, usage: {}, spent: 0, steps: {}, done: false }),
  step(state, line) {
    if (state.done) return { state, verdicts: [] };
    if (line.kind === 'signal') {
      const s = (line as JournalLine<'signal'>).data;
      if (s.signal !== ESTIMATE_HISTORY) return { state, verdicts: [] };
      return { state: { ...state, upper: estimateUpper(s.detail) }, verdicts: [] };
    }
    if (line.kind === 'session.started') {
      const d = (line as JournalLine<'session.started'>).data;
      return {
        state: { ...state, steps: { ...state.steps, [d.sessionId]: d.stepId } },
        verdicts: [],
      };
    }
    if (line.kind !== 'turn.usage') return { state, verdicts: [] };
    const u = (line as JournalLine<'turn.usage'>).data;
    const key = `${u.sessionId}|${u.messageId}`;
    const tokens = u.input + u.cacheWrite + u.output;
    const before = Object.hasOwn(state.usage, key) ? (state.usage[key] as number) : 0;
    const spent = state.spent - before + tokens;
    const next = { ...state, usage: { ...state.usage, [key]: tokens }, spent };
    if (state.upper === null || spent <= SPEND_OVER_FACTOR * state.upper)
      return { state: next, verdicts: [] };
    const stepId = Object.hasOwn(state.steps, u.sessionId) ? state.steps[u.sessionId] : undefined;
    const times = Math.round((spent / state.upper) * 10) / 10;
    return {
      state: { ...next, done: true },
      verdicts: [
        {
          fired: true,
          signal: SPEND_OVER_ESTIMATE_SIGNAL,
          subject: line.taskId,
          detail: `spent ${spent} budget tokens = ${times}× the launch estimate's upper bound ${state.upper}; note only, the task goes on`,
          reasons: [
            `task spend ${spent} > ${SPEND_OVER_FACTOR} × estimate upper bound ${state.upper} (message ${u.messageId})`,
            'no spend cap and no ask (F3): shown in the feed only',
          ],
          key: `${SPEND_OVER_ESTIMATE_SIGNAL}:${line.taskId}`,
          sessionId: u.sessionId,
          ...(stepId ? { stepId } : {}),
          inputs: [line.seq],
        },
      ],
    };
  },
};
