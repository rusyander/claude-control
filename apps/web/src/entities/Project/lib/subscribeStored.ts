import { listeners } from '../model/useTestedProject.constants';

export function subscribeStored(listener: (id: string) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
