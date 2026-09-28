/** Прямоугольник на экране — только нужные поля `DOMRect`. */
export interface PlaceRect {
  top: number;
  right: number;
}

export interface PopoverPlaceInput {
  /** Строка, у которой открыто окно. */
  anchor: PlaceRect;
  /** Видимая область строки (боковая панель); нет — строка видна вся. */
  clip?: Pick<PlaceRect, 'right'>;
  width: number;
  height: number;
  viewport: { width: number; height: number };
  gap: number;
  margin: number;
}

export interface PopoverPlacement {
  left: number;
  top: number;
}
