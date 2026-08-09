import type { ProjectTestCase } from '@claude-control/contracts';

export interface ProjectTestRowProps {
  testCase: ProjectTestCase;
  isChecked: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}
