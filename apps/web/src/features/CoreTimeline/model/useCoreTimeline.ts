import { useReducer } from 'react';
import { useCoreTaskEvents } from '@entities/CoreTask';
import { EMPTY_FOLD, foldEvent } from './fold';
import type { TimelineFold } from './fold.types';

export interface CoreTimelineState {
  fold: TimelineFold;
  /** Связь оборвалась, поток переподключается с последнего номера. */
  dropped: boolean;
  /** Ядро не отдало поток (код ответа); повтор — по решению страницы. */
  refusal: number | undefined;
}

/**
 * Живая лента задачи: строки потока сворачиваются по одной. Повтор номера после переподключения
 * свёртка отбрасывает сама; новая задача — новый экземпляр (страница ставит `key={taskId}`),
 * поэтому свёртка прежней задачи не смешивается с новой.
 */
export function useCoreTimeline(taskId: string): CoreTimelineState {
  const [fold, dispatch] = useReducer(foldEvent, EMPTY_FOLD);
  const { dropped, refusal } = useCoreTaskEvents(taskId, dispatch);
  return { fold, dropped, refusal };
}
