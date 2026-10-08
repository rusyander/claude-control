import type { ProjectTestReport } from '@agentdeck/contracts';

export interface TestsReportTotalsProps {
  /** Итоги из уже загруженного отчёта вкладки — своего запроса у карточки нет. */
  totals: ProjectTestReport['totals'];
}
