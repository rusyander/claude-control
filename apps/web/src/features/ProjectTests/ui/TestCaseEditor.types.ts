import type {
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestSchema,
  ProjectTestSharedStep,
} from '@agentdeck/contracts';

export interface TestCaseEditorProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Не задан — форма заводит новый кейс. */
  testCase?: ProjectTestCase;
  /** Проект и группа кейса — по ним карточка показывает историю результатов. */
  projectPath?: string;
  groupId?: string;
  /** Подпись последнего прогона агента: сменилась — история кейса перечитана. */
  runStamp?: string;
  sharedSteps: ProjectTestSharedStep[];
  /** Свои поля проекта: из них строятся дополнительные поля формы. */
  schema: ProjectTestSchema;
  /** Секции, которые уже есть, — подсказка под полем секции. */
  sections: string[];
  onSave: (input: ProjectTestCaseInput) => Promise<unknown>;
}
