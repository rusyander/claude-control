import type { CommandRow } from '@entities/Command';

export interface CommandItemProps {
  row: CommandRow;
  onOpen: () => void;
}
