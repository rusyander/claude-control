import type { BoardCard } from '@agentdeck/contracts/core/board';
import type { BoardMove } from '@entities/CoreTask';

export interface CoreTaskCardModalProps {
  card: BoardCard;
  /** Колонка карточки в порядке доски — сосед сверху для хода «Выше». */
  column: readonly BoardCard[];
  onClose: () => void;
  /** Ход карточки — состояние доски, не окна (отказ переживает перечитку). */
  move: BoardMove;
  /** Снимок карточки в миг хода из окна. */
  onSend: (card: BoardCard) => void;
  /** Окно держит снимок: карточка на доске уже ушла или стала другой. */
  stale: boolean;
}
