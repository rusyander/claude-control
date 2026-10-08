import type { ReadableStorage, WindowMemory } from './windowMemory.types';
import { WINDOW_MEMORY_KEY } from './windowMemory.constants';

export function readWindowMemory(storage: ReadableStorage | undefined): WindowMemory | undefined {
  try {
    const raw = storage?.getItem(WINDOW_MEMORY_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<WindowMemory>;
    if (typeof value.conversationId !== 'string' || !value.conversationId) return undefined;
    return { conversationId: value.conversationId, turnOpen: value.turnOpen === true };
  } catch {
    // Битая запись или хранилище недоступно — окно начинает с чистого листа.
    return undefined;
  }
}
