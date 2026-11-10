import type { BoardCard } from '@agentdeck/contracts/core/board';

export interface CoreTakeoverActionProps {
  taskId: string;
  card: BoardCard;
  /** Команда ушла (перехват или возврат): окно карточки перечитывает доску. */
  onDone?: () => void;
}
