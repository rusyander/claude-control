import type { ChatProgress } from '@claude-control/contracts';
import type { QueuedMessage } from '@shared/lib/agent-runs';
import type { ChatSendFile } from './ChatPage.types';

export interface ChatDockProps {
  /** План агента и дерево субагентов — read-only, из транскрипта. */
  progress?: ChatProgress;
  isRunning: boolean;
  /** Дописанное, что уйдёт агенту, когда он закончит текущий ход. */
  queued: QueuedMessage[];
  onCancelQueued: (id: string) => void;
  value: string;
  onChange: (value: string) => void;
  /** `false` — сообщение не приняли: вложения остаются в поле. */
  onSend: (files: ChatSendFile[]) => Promise<boolean>;
  onStop: () => void;
}
