import { yieldedEscapes } from './side-dock.constants';

export function yieldEscapeToSideDock(event: Event): void {
  yieldedEscapes.add(event);
  event.preventDefault();
}
