import type { ProjectTestEnvironment } from '@agentdeck/contracts';

export interface TestPlanRecipeModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  environments: ProjectTestEnvironment[];
}
