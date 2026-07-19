import type { Hook } from '@claude-control/contracts';

export interface HookFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание нового хука, иначе правка существующего. */
  hook?: Hook;
}
