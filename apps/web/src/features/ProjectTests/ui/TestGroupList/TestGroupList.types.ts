import type { ProjectTestGroup } from '@agentdeck/contracts';

export interface TestGroupListProps {
  groups: ProjectTestGroup[];
  /** Открытая группа или `ALL_GROUPS` — сквозной список. */
  activeId: string;
  onSelect: (id: string) => void;
  /** Завести новую группу — кнопка стоит под списком, там, где группы кончаются. */
  onAdd: () => void;
}
