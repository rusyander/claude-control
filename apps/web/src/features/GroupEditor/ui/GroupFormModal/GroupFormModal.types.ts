import type { Group } from '@agentdeck/contracts';

export interface GroupFormModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Пусто — создание новой группы, иначе правка существующей. */
  group?: Group;
}
