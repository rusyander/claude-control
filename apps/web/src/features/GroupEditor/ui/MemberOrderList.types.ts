import type { GroupMember, GroupMembersView } from '@agentdeck/contracts';

export interface MemberOrderListProps {
  value: GroupMember[];
  /** Имя участника из списков панели — пока сервер не описал его словами. */
  labelOf: (member: GroupMember) => string;
  /** Одна строка из файла участника (описание скилла, команда хука). */
  rawLineOf: (member: GroupMember) => string;
  /** Описания сохранённой группы; у новой — нет. */
  described?: GroupMembersView;
  /** Место, куда встанет следующий отмеченный участник; нет — в конец. */
  insertAt?: number;
  onInsertAt: (position: number | undefined) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
}

export interface MemberOrderSlotProps {
  position: number;
  isActive: boolean;
  onInsert: () => void;
}
