import { listeners } from './composer-request.constants';

export function onComposerModeRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
