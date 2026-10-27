import type { GroupWatchCoverageSummary } from '@agentdeck/contracts/group-watch';

export interface GroupWatchCoverageLineProps {
  /** Ответ сервера; ещё не пришёл — строки нет (не «групп нет», это была бы неправда). */
  summary: GroupWatchCoverageSummary | undefined;
  enabled: boolean;
}
