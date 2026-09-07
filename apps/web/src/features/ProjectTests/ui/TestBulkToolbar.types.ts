import type { ProjectTestBulkInput, ProjectTestGroup } from '@agentdeck/contracts';

export interface TestBulkToolbarProps {
  /** Отмеченные кейсы активной группы. */
  checked: string[];
  groupId: string;
  /** Куда можно перенести кейсы: остальные группы проекта. */
  groups: ProjectTestGroup[];
  /** Секции, которые уже есть, — чтобы не набирать путь заново. */
  sections: string[];
  onApply: (payload: ProjectTestBulkInput) => Promise<unknown>;
  onClear: () => void;
}
