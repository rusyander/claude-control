import type { ProjectTestCase } from '@agentdeck/contracts';

export interface ProjectTestRowProps {
  testCase: ProjectTestCase;
  isChecked: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}
