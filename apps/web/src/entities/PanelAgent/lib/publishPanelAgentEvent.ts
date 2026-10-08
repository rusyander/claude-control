import { isPanelAgentEvent } from './isPanelAgentEvent';
import { listeners } from '../model/events.constants';

/**
 * Передать кадр подписчикам. Зовёт его `FileWatchProvider`: второй
 * `EventSource` на тот же поток означал бы второе соединение и второй пропуск
 * кадров при обрыве — ровно то, от чего сервер кладёт кадры агента в общий поток.
 */
export function publishPanelAgentEvent(payload: unknown): boolean {
  if (!isPanelAgentEvent(payload)) return false;
  for (const listener of listeners) listener(payload);
  return true;
}
