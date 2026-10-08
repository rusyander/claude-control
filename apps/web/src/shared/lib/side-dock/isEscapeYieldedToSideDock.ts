import { yieldedEscapes } from './side-dock.constants';

export function isEscapeYieldedToSideDock(event: Event): boolean {
  return yieldedEscapes.has(event);
}
