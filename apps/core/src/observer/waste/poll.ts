import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate, SignalVerdict } from '../observer.types.ts';
import { contextOf, toolEventOf, whereOf } from './facts.ts';

/**
 * Цикл ожидания (06:137, F6): вызовы класса `wait` (сон оболочки, чтение вывода фонового процесса)
 * подряд в одном контексте. Серию рвёт любой вызов другого класса в этой сессии или пробуждение
 * CLI (`turn.cli-initiated`). Второе ожидание подряд — подсказка; остановка — на первом ожидании
 * после того, как подсказка дошла до модели (`message.delivered{kind:'hint'}`), или на четвёртом
 * подряд (подсказка не доходит посреди хода — без предела серия ждала бы конца хода вечно).
 */

export const WASTE_POLL = 'waste-poll';

/** Ожиданий подряд до подсказки и до остановки без доставленной подсказки. */
export const POLL_HINT_AT = 2;
export const POLL_STOP_AT = 4;

interface Run {
  count: number;
  epoch: number;
  sessionId: string;
  hinted: boolean;
  delivered: boolean;
}

export interface PollState {
  runs: ReadonlyMap<string, Run>;
}

function bySession(state: PollState, sessionId: string, change: (r: Run) => Run | null): PollState {
  const runs = new Map<string, Run>();
  let moved = false;
  for (const [k, r] of state.runs) {
    const next = r.sessionId === sessionId ? change(r) : r;
    if (next !== r) moved = true;
    if (next) runs.set(k, next);
  }
  return moved ? { runs } : state;
}

function onLine(state: PollState, line: JournalLine): PollState | null {
  if (line.kind === 'turn.cli-initiated') {
    const sid = (line as JournalLine<'turn.cli-initiated'>).data.sessionId;
    return bySession(state, sid, () => null);
  }
  if (line.kind === 'message.delivered') {
    const d = (line as JournalLine<'message.delivered'>).data;
    if (d.ref.kind !== 'hint') return state;
    return bySession(state, d.sessionId, (r) =>
      r.hinted && !r.delivered ? { ...r, delivered: true } : r,
    );
  }
  return null;
}

export const pollPredicate: Predicate<PollState> = {
  ids: [WASTE_POLL],
  init: () => ({ runs: new Map() }),
  step(state, line) {
    const other = onLine(state, line);
    if (other) return { state: other, verdicts: [] };
    const ev = toolEventOf(line);
    if (!ev) return { state, verdicts: [] };
    const d = ev.data;
    if (d.effectClass !== 'wait')
      return { state: bySession(state, d.sessionId, () => null), verdicts: [] };
    const ctx = contextOf(d);
    const prev = state.runs.get(ctx);
    const run: Run = {
      count: (prev?.count ?? 0) + 1,
      epoch: prev?.epoch ?? line.seq,
      sessionId: d.sessionId,
      hinted: prev?.hinted ?? false,
      delivered: prev?.delivered ?? false,
    };
    const verdicts: SignalVerdict[] = [];
    const base = {
      fired: true as const,
      signal: WASTE_POLL,
      subject: d.display ?? d.tool,
      ...whereOf(line),
      inputs: [line.seq],
    };
    if (run.delivered || run.count >= POLL_STOP_AT) {
      verdicts.push({
        ...base,
        detail: run.delivered
          ? `waited again after the hint reached the model (${run.count} waits in a row)`
          : `${run.count} waits in a row with nothing else happening`,
        reasons: [
          run.delivered
            ? 'the poll hint was delivered and the session waits again'
            : `${POLL_STOP_AT}th consecutive wait`,
        ],
        key: `${WASTE_POLL}:${ctx}:${run.epoch}:stop`,
        escalated: true,
      });
    } else if (run.count === POLL_HINT_AT) {
      run.hinted = true;
      verdicts.push({
        ...base,
        detail: `${run.count} waits in a row with nothing else happening`,
        reasons: [`${POLL_HINT_AT} consecutive waits in one context`],
        key: `${WASTE_POLL}:${ctx}:${run.epoch}:hint`,
      });
    }
    return { state: { runs: new Map(state.runs).set(ctx, run) }, verdicts };
  },
};
