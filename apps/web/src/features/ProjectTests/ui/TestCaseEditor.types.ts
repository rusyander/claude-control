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
  sharedSteps: ProjectTestSharedStep[];
  /** Свои поля проекта: из них строятся дополнительные поля формы. */
  schema: ProjectTestSchema;
  /** Секции, которые уже есть, — подсказка под полем секции. */
  sections: string[];
  onSave: (input: ProjectTestCaseInput) => Promise<unknown>;
}
