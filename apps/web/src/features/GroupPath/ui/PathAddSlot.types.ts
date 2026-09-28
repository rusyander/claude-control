export interface PathAddSlotProps {
  label: string;
  /** `afterIndex` этого места: и вставка «+», и перенос шага сюда. */
  afterIndex: number;
  /** Идёт перенос — все места видны как линии, куда можно положить. */
  isDropping: boolean;
  /** Сюда положат шаг, если отпустить сейчас. */
  isDropTarget: boolean;
  onAdd: () => void;
}
