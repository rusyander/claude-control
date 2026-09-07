import type { ProjectTestEnvironment } from '@agentdeck/contracts';

export interface TestExchangeModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Путь проекта: обмен идёт по пути, как и всё остальное в разделе. */
  path?: string;
  /** Открытая группа — в неё кладутся кейсы и из неё идёт выгрузка. */
  groupId: string;
  /** Окружения проекта: результату из CI можно назвать, где он получен. */
  environments: ProjectTestEnvironment[];
}
