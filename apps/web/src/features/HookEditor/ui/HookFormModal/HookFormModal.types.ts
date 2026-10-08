import type { Hook } from '@agentdeck/contracts';

export interface HookFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового хука, иначе правка существующего. */
  hook?: Hook;
}
