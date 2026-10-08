import { DOCK_WIDTH_KEY } from './dockWidth.constants';

export type ReadableStorage = Pick<Storage, 'getItem'>;

/** Ширина по умолчанию — прежняя постоянная. */
export const DOCK_WIDTH_DEFAULT = 440;

/** Сохранённая ширина; нет её или она битая — по умолчанию. */
export function readDockWidth(storage: ReadableStorage | undefined): number {
  try {
    const value = Number(storage?.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? value : DOCK_WIDTH_DEFAULT;
  } catch {
    return DOCK_WIDTH_DEFAULT;
  }
}
