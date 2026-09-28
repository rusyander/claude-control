import type { KnobView, PathStep } from '@agentdeck/contracts';
import type { PathRow } from '../model/pathRows';
import type { RowText } from '../model/describe';
import type { RowType, RowWords } from '../model/rowWords';
import type { DragHandleProps } from '../model/useStepDrag';

export interface PathEntryRowProps {
  row: PathRow;
  /** Номер шага с единицы. */
  number: number;
  words: RowWords;
  type: RowType;
  /**
   * Подсказке нечего сказать словами (ресурс без описания) — она спросит
   * сводку ресурса, но только показанной: это запрос к серверу.
   */
  fallback?: RowText;
  /** Шаг-ссылка на скилл без чисел: «числа читаются…» или «чисел нет» — видно, а не пусто. */
  knobsNote?: string;
  isKnobSaving: boolean;
  /** Этот шаг сейчас переносят — строка приглушена. */
  isDragging: boolean;
  /** Только у своего шага: ручка переноса. */
  dragHandle?: DragHandleProps;
  onOpen: () => void;
  onKnob: (knob: KnobView, value: number | null) => void;
  onEdit: (step: PathStep) => void;
  onRemove: (step: PathStep) => void;
}

export interface RowHintProps {
  id: string;
  isShown: boolean;
  words: RowWords;
  fallback?: RowText;
}
