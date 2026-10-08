import type { Listener } from '../model/events.types';
import { listeners } from '../model/events.constants';

export function subscribePanelAgentEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
