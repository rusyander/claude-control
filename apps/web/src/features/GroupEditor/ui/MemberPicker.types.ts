import type { GroupMember } from '@claude-control/contracts';

export interface MemberPickerProps {
  value: GroupMember[];
  onChange: (members: GroupMember[]) => void;
  /**
   * Правящаяся группа. Её нельзя добавить в саму себя, поэтому она исключается
   * из списка выбираемых групп (цикл при этом всё равно отвергнет сервер).
   */
  excludeGroupId?: string;
}
