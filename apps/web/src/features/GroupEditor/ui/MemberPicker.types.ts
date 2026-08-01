import type { GroupMember, GroupMemberKind } from '@claude-control/contracts';

/** Строка сводного списка: сущность любого вида под общим подписанным видом. */
export interface PickerItem {
  kind: GroupMemberKind;
  id: string;
  label: string;
}

export interface MemberPickerProps {
  value: GroupMember[];
  onChange: (members: GroupMember[]) => void;
  /**
   * Правящаяся группа. Её нельзя добавить в саму себя, поэтому она исключается
   * из списка выбираемых групп (цикл при этом всё равно отвергнет сервер).
   */
  excludeGroupId?: string;
}
