import type { ProjectInfo } from '@entities/Project';
import type { ListedProject } from '../../lib/withRegistry';

export interface OpenProjectsDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projects: ListedProject[];
  /** Нормализованные пути уже открытых вкладок — они в списке, но не выбираются. */
  openIds: ReadonlySet<string>;
  onOpen: (projects: ProjectInfo[]) => void;
}
