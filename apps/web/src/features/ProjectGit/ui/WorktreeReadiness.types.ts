import type { WorktreeCopyState } from '@entities/ProjectGit';

export interface WorktreeReadinessProps {
  /** Полнота копии на момент последнего чтения списка. */
  state: WorktreeCopyState;
  /** Идёт другая операция раздела — добор тоже ждёт. */
  disabled: boolean;
  /** Добрать недостающее: перенос локального слоя заново + запись доступа. */
  onRepair: () => void;
}
