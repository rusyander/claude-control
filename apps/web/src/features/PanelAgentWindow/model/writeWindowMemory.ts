import type { WritableStorage, WindowMemory } from './windowMemory.types';
import { WINDOW_MEMORY_KEY } from './windowMemory.constants';

export function writeWindowMemory(
  storage: WritableStorage | undefined,
  memory: WindowMemory | undefined,
): void {
  try {
    if (memory) storage?.setItem(WINDOW_MEMORY_KEY, JSON.stringify(memory));
    else storage?.removeItem(WINDOW_MEMORY_KEY);
  } catch {
    // Приватный режим или запрет данных сайта: окно работает без памяти через F5.
  }
}
