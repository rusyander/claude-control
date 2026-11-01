import type { ReportRef } from '@agentdeck/contracts/core/task-view';

export interface ReportViewProps {
  taskId: string;
  /** Ссылка из вида задачи; `null` — отчёта ещё нет. */
  reportRef: ReportRef | null;
}
