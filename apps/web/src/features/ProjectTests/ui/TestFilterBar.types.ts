import type { ProjectTestView } from '@agentdeck/contracts';
import type { TestFilters } from '../model/useTestFilters';
import type { TestsBudget } from '../model/useTestsBoard';

export interface TestFilterBarProps {
  filters: TestFilters;
  /** Сохранённые наборы: они же динамические наборы тест-планов. */
  views: ProjectTestView[];
  onSaveView: (view: ProjectTestView) => void;
  onRemoveView: (id: string) => void;
  /** «У меня N минут»: отметить видимые кейсы под бюджет по убыванию риска. */
  onPickBudget: (minutes: number) => void;
  /** Итог последнего набора — строкой под отбором. */
  budget?: TestsBudget;
}
