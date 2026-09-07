import type { ProjectTestAttributeDef, ProjectTestCase } from '@agentdeck/contracts';
import type { CaseWithGroup } from '@entities/ProjectTest';

export interface TestCaseTableProps {
  rows: CaseWithGroup[];
  /** Всего кейсов до отбора — для подписи «показано N из M». */
  total: number;
  checked: string[];
  onToggle: (id: string) => void;
  onCheckAll: () => void;
  onClearChecked: () => void;
  /** Свои поля проекта: они становятся колонками. */
  attributes: ProjectTestAttributeDef[];
  onEdit: (testCase: ProjectTestCase, groupId: string) => void;
  onRemove: (testCase: ProjectTestCase, groupId: string) => void;
  /** Показывать колонку группы — когда список собран из нескольких файлов. */
  withGroup?: boolean;
}
