import type { StepDef } from '@agentdeck/contracts/core/scenario';

export interface StepListProps {
  steps: StepDef[];
  /** Индекс шага, чья форма открыта. */
  selected: number;
  /** Идёт запрос к ядру: жесты переноса не принимаются, ручки остаются в фокусе. */
  isBusy: boolean;
  onSelect: (index: number) => void;
  /** Новый шаг на место после `afterIndex` (-1 — в начало). */
  onInsert: (afterIndex: number) => void;
  onMove: (from: number, afterIndex: number) => void;
  onRemove: (index: number) => void;
}
