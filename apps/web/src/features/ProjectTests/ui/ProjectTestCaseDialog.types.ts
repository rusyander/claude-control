import type { ProjectTestCase, ProjectTestCaseInput } from '@agentdeck/contracts';

export interface ProjectTestCaseDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Правим существующий кейс; пусто — заводим новый. */
  testCase?: ProjectTestCase;
  onSave: (input: ProjectTestCaseInput) => Promise<unknown>;
}
