import { DOCK_WIDTH_MIN } from './dockWidth.constants';
import { dockWidthMax } from './dockWidth';

export function clampDockWidth(width: number, viewport: number): number {
  return Math.round(Math.min(dockWidthMax(viewport), Math.max(DOCK_WIDTH_MIN, width)));
}
