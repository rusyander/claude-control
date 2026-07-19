export interface ResizeHandleProps {
  /** Текущая ширина панели в пикселях. */
  width: number;
  onResize: (width: number) => void;
  min?: number;
  max?: number;
  /** Подпись для скринридера. */
  label: string;
}
