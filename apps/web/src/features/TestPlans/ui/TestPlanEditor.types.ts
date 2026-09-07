import type {
  ProjectTestEnvironment,
  ProjectTestGroup,
  ProjectTestPlan,
  ProjectTestView,
} from '@agentdeck/contracts';

export interface TestPlanEditorProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Не задан — заводится новый план. */
  plan?: ProjectTestPlan;
  groups: ProjectTestGroup[];
  /** Сохранённые наборы: из них берётся динамический состав плана. */
  views: ProjectTestView[];
  environments: ProjectTestEnvironment[];
  onSave: (plan: ProjectTestPlan) => void;
}
