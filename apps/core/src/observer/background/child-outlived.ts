import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { Predicate } from '../observer.types.ts';

export const CHILD_OUTLIVED_PARENT_SIGNAL = 'child-outlived-parent';

interface OpenChild {
  readonly nodeId: string;
  readonly parent: string;
  readonly sessionId: string;
  readonly kind: 'agent' | 'bg';
}

export interface ChildOutlivedFold {
  readonly open: readonly OpenChild[];
  /** Субагенты сессии — родители, чей конец судится (`agent.ended`). */
  readonly agents: readonly string[];
  readonly steps: Readonly<Record<string, string>>;
}

/**
 * Ребёнок пережил родителя (этап 11, P148): субагент кончился (`agent.ended`), а начатые в его
 * контексте вложенный субагент или фоновая работа ещё идут — показать человеку, кто остался без
 * родителя. Конец СЕССИИ с идущей фоновой работой — не этот сигнал, а `bg-orphan` сторожа фона
 * (там процесс снимается); субагент без конца при кончившейся сессии — потерянный узел дерева,
 * а не живой ребёнок. Один сигнал на ребёнка.
 */
export const childOutlivedParent: Predicate<ChildOutlivedFold> = {
  ids: [CHILD_OUTLIVED_PARENT_SIGNAL],
  init: () => ({ open: [], agents: [], steps: {} }),
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
        const parent =
          d.parentToolUseId && state.agents.includes(d.parentToolUseId) ? d.parentToolUseId : null;
        const open = parent
          ? [
              ...state.open,
              { nodeId: d.toolUseId, parent, sessionId: d.sessionId, kind: 'agent' as const },
            ]
          : state.open;
        return { state: { ...state, open, agents: [...state.agents, d.toolUseId] }, verdicts: [] };
      }
      case 'bg.started': {
        const d = (line as JournalLine<'bg.started'>).data;
        const parent = d.ownerChain.parentToolUseId;
        if (!parent || !state.agents.includes(parent)) return { state, verdicts: [] };
        const child = {
          nodeId: d.itemId,
          parent,
          sessionId: d.ownerChain.sessionId,
          kind: 'bg' as const,
        };
        return { state: { ...state, open: [...state.open, child] }, verdicts: [] };
      }
      case 'bg.ended': {
        const id = (line as JournalLine<'bg.ended'>).data.itemId;
        return {
          state: { ...state, open: state.open.filter((c) => c.nodeId !== id) },
          verdicts: [],
        };
      }
      case 'agent.ended': {
        const d = (line as JournalLine<'agent.ended'>).data;
        const rest = state.open.filter((c) => c.nodeId !== d.toolUseId);
        const orphans = rest.filter((c) => c.parent === d.toolUseId);
        if (orphans.length === 0) return { state: { ...state, open: rest }, verdicts: [] };
        return {
          state: { ...state, open: rest.filter((c) => c.parent !== d.toolUseId) },
          verdicts: orphans.map((c) => {
            const stepId = Object.hasOwn(state.steps, c.sessionId)
              ? state.steps[c.sessionId]
              : undefined;
            return {
              fired: true as const,
              signal: CHILD_OUTLIVED_PARENT_SIGNAL,
              subject: c.nodeId,
              detail: `${c.kind === 'bg' ? 'background item' : 'subagent'} ${c.nodeId} is still running after its parent subagent ${d.toolUseId} ended (${d.how})`,
              reasons: [
                `parent ${d.toolUseId} ended at seq ${line.seq}; child ${c.nodeId} has no end row`,
              ],
              key: `${CHILD_OUTLIVED_PARENT_SIGNAL}:${c.nodeId}`,
              sessionId: c.sessionId,
              ...(stepId ? { stepId } : {}),
              inputs: [line.seq],
            };
          }),
        };
      }
      default:
        return { state, verdicts: [] };
    }
  },
};
