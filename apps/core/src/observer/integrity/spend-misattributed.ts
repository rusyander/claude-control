import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate, SignalVerdict } from '../observer.types.ts';

export const SPEND_MISATTRIBUTED_SIGNAL = 'spend-misattributed';

interface Pending {
  readonly sessionId: string;
  readonly parent: string;
  readonly usage: Readonly<Record<string, number>>;
  readonly seqs: readonly number[];
}

export interface MisattributedFold {
  /** Вызовы субагентов, которые сессия запустила (`sessionId:toolUseId`). */
  readonly spawned: readonly string[];
  /** Строки расхода, назвавшие вызов, которого сессия (ещё) не запускала. */
  readonly pending: Readonly<Record<string, Pending>>;
  readonly steps: Readonly<Record<string, string>>;
}

const tokensOf = (p: Pending): number => Object.values(p.usage).reduce((a, b) => a + b, 0);

function verdictOf(p: Pending, steps: MisattributedFold['steps']): SignalVerdict {
  const tokens = tokensOf(p);
  const stepId = Object.hasOwn(steps, p.sessionId) ? steps[p.sessionId] : undefined;
  return {
    fired: true,
    signal: SPEND_MISATTRIBUTED_SIGNAL,
    subject: p.parent,
    detail: `${p.seqs.length} usage rows (${tokens} budget tokens) name subagent call ${p.parent} the session never spawned; not added to the parent session`,
    reasons: [
      `turn.usage parentToolUseId ${p.parent} has no agent.spawned in session ${p.sessionId}`,
      'spend stays unattributed: never charged to the parent (P149)',
    ],
    key: `${SPEND_MISATTRIBUTED_SIGNAL}:${p.sessionId}:${p.parent}`,
    sessionId: p.sessionId,
    ...(stepId ? { stepId } : {}),
    inputs: [...p.seqs],
  };
}

/**
 * Чужой расход (этап 11, P149): строка `turn.usage` называет вызов субагента
 * (`parentToolUseId`), которого сессия не запускала, — расход не прибавляется к родителю, а
 * назван. Строка могла прийти раньше `agent.spawned` своего вызова (поток CLI сливает пачкой),
 * поэтому суд — на конце сессии (`ended`/`lost`) или задачи: не дождалась запуска — сигнал,
 * один на сессию × вызов. Строки без поля (до этапа 11) и главный контекст (`null`) — не его.
 */
export const spendMisattributed: Predicate<MisattributedFold> = {
  ids: [SPEND_MISATTRIBUTED_SIGNAL],
  init: () => ({ spawned: [], pending: {}, steps: {} }),
  step(state, line) {
    switch (line.kind) {
      case 'session.started': {
        const d = (line as JournalLine<'session.started'>).data;
        return {
          state: { ...state, steps: { ...state.steps, [d.sessionId]: d.stepId } },
          verdicts: [],
        };
      }
      case 'agent.spawned': {
        const d = (line as JournalLine<'agent.spawned'>).data;
        const key = `${d.sessionId}:${d.toolUseId}`;
        const { [key]: _late, ...pending } = state.pending;
        return { state: { ...state, spawned: [...state.spawned, key], pending }, verdicts: [] };
      }
      case 'turn.usage': {
        const u = (line as JournalLine<'turn.usage'>).data;
        if (typeof u.parentToolUseId !== 'string') return { state, verdicts: [] };
        const key = `${u.sessionId}:${u.parentToolUseId}`;
        if (state.spawned.includes(key)) return { state, verdicts: [] };
        const was = state.pending[key];
        const p: Pending = {
          sessionId: u.sessionId,
          parent: u.parentToolUseId,
          usage: { ...was?.usage, [`${u.messageId}`]: u.input + u.cacheWrite + u.output },
          seqs: [...(was?.seqs ?? []), line.seq],
        };
        return { state: { ...state, pending: { ...state.pending, [key]: p } }, verdicts: [] };
      }
      case 'session.transition': {
        const d = (line as JournalLine<'session.transition'>).data;
        if (d.to !== 'ended' && d.to !== 'lost') return { state, verdicts: [] };
        const due = Object.entries(state.pending).filter(([, p]) => p.sessionId === d.sessionId);
        if (due.length === 0) return { state, verdicts: [] };
        const pending = Object.fromEntries(
          Object.entries(state.pending).filter(([, p]) => p.sessionId !== d.sessionId),
        );
        return {
          state: { ...state, pending },
          verdicts: due.map(([, p]) => verdictOf(p, state.steps)),
        };
      }
      case 'task.ended': {
        const due = Object.values(state.pending);
        return {
          state: { ...state, pending: {} },
          verdicts: due.map((p) => verdictOf(p, state.steps)),
        };
      }
      default:
        return { state, verdicts: [] };
    }
  },
};
