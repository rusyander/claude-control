import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';

export interface TriageChipProps {
  triage: SplitPlanView['triage'];
  /** Прогон разбора идёт прямо сейчас — строка разбора или узел дерева. */
  live: boolean;
  /** Сколько идёт разбор (мс); только у идущего прогона. */
  elapsedMs: number | undefined;
}
