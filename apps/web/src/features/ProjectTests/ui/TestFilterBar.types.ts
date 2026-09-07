import type { ProjectTestView } from '@agentdeck/contracts';
import type { TestFilters } from '../model/useTestFilters';

export interface TestFilterBarProps {
  filters: TestFilters;
  /** Сохранённые наборы: они же динамические наборы тест-планов. */
  views: ProjectTestView[];
  onSaveView: (view: ProjectTestView) => void;
  onRemoveView: (id: string) => void;
}
