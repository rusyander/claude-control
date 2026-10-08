import { DOCK_WIDTH_KEY } from './dockWidth.constants';

export type WritableStorage = Pick<Storage, 'setItem'>;

export function writeDockWidth(storage: WritableStorage | undefined, width: number): void {
  try {
    storage?.setItem(DOCK_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Приватный режим или запрет данных сайта: ширина живёт до перезагрузки.
  }
}
