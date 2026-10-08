import type {
  ProjectTestKind,
  ProjectTestStep,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestLink,
  ProjectTestParameter,
  ProjectTestAutomationStatus,
} from '@agentdeck/contracts';

/**
 * Черновик кейса в форме.
 *
 * Форма правит СВОЮ копию, а не кейс из списка: список во время правки живёт
 * своей жизнью — его перечитывает опрос прогона, — и связывать поля напрямую с
 * ним значит терять набранное на каждом ответе сервера.
 *
 * Списочные поля (теги) держатся строкой ровно потому, что человек их так и
 * набирает: через запятую, одним движением. Разбор — на выходе, в `toInput`.
 */
export interface CaseDraft {
  id?: string;
  type: ProjectTestKind;
  title: string;
  purpose: string;
  area: string;
  section: string;
  precondition: string;
  steps: ProjectTestStep[];
  expected: string;
  postcondition: string;
  oracle: string;
  priority: ProjectTestPriority;
  readiness: ProjectTestReadiness;
  /** Минуты строкой: пустое поле — «не оценивали», а не ноль. */
  duration: string;
  tags: string;
  links: ProjectTestLink[];
  attributes: Record<string, string>;
  parameters: ProjectTestParameter[];
  attachments: string[];
  automationStatus: ProjectTestAutomationStatus;
  automationFile: string;
  automationTestName: string;
  automationExternalId: string;
  /** Файлы кода строками: по ним кейс попадает в «прогнать задетое». */
  codePaths: string;
  archived: boolean;
}
