import type { ProjectTestGroup } from '@agentdeck/contracts';

export interface TestGroupFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Все группы проекта: по ним окно узнаёт занятый идентификатор до запроса. */
  groups: readonly ProjectTestGroup[];
  /** Правка существующей группы; пусто — заводится новая. */
  group?: ProjectTestGroup;
  onCreate: (id: string, title?: string, description?: string) => Promise<unknown>;
  onUpdate: (id: string, title?: string, description?: string) => Promise<unknown>;
}
