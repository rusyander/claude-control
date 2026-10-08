import { STORAGE_KEY, listeners } from '../model/useTestedProject.constants';

export function writeStored(id: string): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // См. выше: запись — удобство, а не условие работы раздела.
  }
  // Id — аргументом, а не из хранилища: в приватном окне хранилище молчит.
  for (const listener of listeners) listener(id);
}
