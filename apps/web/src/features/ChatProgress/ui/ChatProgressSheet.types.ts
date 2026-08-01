import type { ChatProgress } from '@agentdeck/contracts';

export interface ChatProgressSheetProps {
  progress?: ChatProgress;
  /** Агент ещё работает — показываем это в шапке панели. */
  isRunning?: boolean;
}
