import type { AgentHistory } from '@agentdeck/contracts/agent-history';

/** Выбранный субагент: ключ его сессии и его id. */
export interface HistoryPick {
  chatId: string;
  agentId: string;
}

export interface AgentHistoryModalProps {
  history: AgentHistory | undefined;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Идёт ли разговор сейчас — у текущей сессии «идёт» значит работает. */
  isRunning: boolean;
  isLoading: boolean;
}

export interface AgentHistorySessionsProps {
  history: AgentHistory | undefined;
  isLoading: boolean;
  isRunning: boolean;
  picked: HistoryPick | undefined;
  onPick: (pick: HistoryPick) => void;
}

export interface AgentHistoryNowProps {
  history: AgentHistory;
  picked: HistoryPick | undefined;
  onPick: (pick: HistoryPick) => void;
}

export interface AgentHistoryButtonProps {
  /** Любая сессия разговора: сервер сам соберёт все сессии его группы. */
  chatId: string;
  isRunning: boolean;
  className?: string;
}
