import type { ChatProgress } from '@claude-control/contracts';

export interface ChatProgressSheetProps {
  progress?: ChatProgress;
  /** Агент ещё работает — показываем это в шапке панели. */
  isRunning?: boolean;
}
