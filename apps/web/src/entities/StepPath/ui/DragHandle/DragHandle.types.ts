import type { DragHandleProps } from '../../model/useStepDrag';

export interface DragHandleViewProps {
  /** Название шага — в имени ручки для чтения с экрана: «Переставить шаг «…»». */
  title: string;
  /** Обработчики из `useStepDrag().handleProps(...)`. */
  handle: DragHandleProps;
}
