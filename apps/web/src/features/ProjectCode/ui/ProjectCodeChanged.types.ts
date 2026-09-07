import type { ProjectGitInfo } from '@agentdeck/contracts';
import type { ChangedRow } from '../lib/changedRows';

export interface ProjectCodeChangedProps {
  /** Правки агента и изменения рабочего дерева одним списком. */
  rows: ChangedRow[];
  /** Состояние репозитория — ветка и числа над списком. Не репозиторий — пусто. */
  git?: ProjectGitInfo;
  isLoading: boolean;
  /** Правок агента не поместилось в список (файлы вне проекта). */
  skipped?: number;
  selected?: string;
  onSelect: (path: string) => void;
}
