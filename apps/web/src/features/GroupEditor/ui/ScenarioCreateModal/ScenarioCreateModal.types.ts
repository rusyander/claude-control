import type { Group } from '@agentdeck/contracts';

export interface ScenarioCreateModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Сценарий создан — страница открывает его окно на «Порядке работы». */
  onCreated: (group: Group) => void;
}
