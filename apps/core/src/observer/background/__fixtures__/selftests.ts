import { journalLines, type SelftestPair } from '../../__fixtures__/selftest.ts';
import { S1, sessionStarted } from '../../integrity/__fixtures__/selftests.ts';

/**
 * Пары самопроверки сторожа фона (P33): «ребёнок пережил родителя» срабатывает, когда субагент
 * кончился, а вложенный субагент или фоновая работа, начатые в его контексте, ещё идут; двойник —
 * тот же журнал, где ребёнок кончился раньше родителя.
 */

export const PARENT = 'toolu_parent';
export const CHILD = 'toolu_child';

export const spawned = (toolUseId: string, parentToolUseId: string | null) => ({
  kind: 'agent.spawned' as const,
  sessionId: S1,
  data: {
    sessionId: S1,
    toolUseId,
    parentToolUseId,
    cliTaskId: `cli-${toolUseId}`,
    kind: 'subagent',
    subagentType: 'general-purpose',
    model: 'model-a',
    effort: null,
    background: false,
    depth: parentToolUseId ? 2 : 1,
    briefExcerpt: null,
  },
});

export const agentEnded = (toolUseId: string) => ({
  kind: 'agent.ended' as const,
  sessionId: S1,
  data: {
    sessionId: S1,
    toolUseId,
    cliTaskId: `cli-${toolUseId}`,
    how: 'completed',
    usage: null,
    summaryExcerpt: null,
  },
});

/** Вложенный субагент ещё идёт, когда его родитель уже кончился. */
export const CHILD_OUTLIVES = journalLines([
  sessionStarted(S1),
  spawned(PARENT, null),
  spawned(CHILD, PARENT),
  agentEnded(PARENT),
]);
/** Почти-двойник: ребёнок кончился раньше родителя. */
export const CHILD_ENDS_FIRST = journalLines([
  sessionStarted(S1),
  spawned(PARENT, null),
  spawned(CHILD, PARENT),
  agentEnded(CHILD),
  agentEnded(PARENT),
]);

export const SELFTESTS: SelftestPair[] = [
  { signal: 'child-outlived-parent', fires: CHILD_OUTLIVES, silent: CHILD_ENDS_FIRST },
];
