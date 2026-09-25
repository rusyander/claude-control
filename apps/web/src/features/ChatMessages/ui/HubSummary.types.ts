import type { ChildStageGroup } from './ChildStages.types';

export interface HubSummaryProps {
  /** Все строки хаба: разбор и отброшенные чаты сводка отсеивает сама. */
  groups: ChildStageGroup[];
  /** «Сейчас» — тикает у хаба, пока что-то идёт. */
  now: number;
}
