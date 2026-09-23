import type {
  ChatProgress,
  ProgressAgent,
  ProgressShell,
  ProgressTask,
} from '@agentdeck/contracts';

export interface ChatProgressSheetProps {
  progress?: ChatProgress;
  /** Агент ещё работает — показываем это в шапке панели. */
  isRunning?: boolean;
}

export interface TaskRowProps {
  task: ProgressTask;
}

export interface AgentRowProps {
  agent: ProgressAgent;
}

export interface ShellRowProps {
  shell: ProgressShell;
  /** Ход ещё идёт. */
  isRunning: boolean;
  /** Жив ли процесс CLI разговора: нет — «идущая» команда умерла вместе с ним. */
  processAlive?: boolean;
  /** Текущее время для таймера — один на всю панель. */
  now: number;
}
