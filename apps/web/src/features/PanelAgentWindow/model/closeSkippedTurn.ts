import type { ReadableStorage, WritableStorage, WindowMemory } from './windowMemory.types';
import { readWindowMemory } from './readWindowMemory';
import { writeWindowMemory } from './writeWindowMemory';

/**
 * Восстановление пропущено: в ленту до ответа сервера уже легла заметка. Сам
 * разговор не подменяем, но «ход открыт» из памяти снимаем — иначе следующий F5
 * снова сказал бы «ход оборван перезагрузкой» о ходе, которого давно нет
 * (F-288). Пишем, только если память всё та же: успевший начаться новый ход
 * записал свою, и её не трогаем.
 */
export function closeSkippedTurn(
  storage: (ReadableStorage & WritableStorage) | undefined,
  read: WindowMemory,
): void {
  if (!read.turnOpen) return;
  const now = readWindowMemory(storage);
  if (now?.conversationId !== read.conversationId || !now.turnOpen) return;
  writeWindowMemory(storage, { conversationId: read.conversationId, turnOpen: false });
}
