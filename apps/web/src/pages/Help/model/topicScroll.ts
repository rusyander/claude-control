import type { HistoryActionType } from './topicScroll.types';

/** Назад, вперёд и `go(n)` — возврат к записи, где читатель уже был. */
export function isHistoryMove(action: HistoryActionType | undefined): boolean {
  return action === 'BACK' || action === 'FORWARD' || action === 'GO';
}
