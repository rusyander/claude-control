import type { GroupMember, GroupScope } from '@agentdeck/contracts';

export type { PickerItem } from '../model/memberCatalog.types';

export interface MemberPickerProps {
  value: GroupMember[];
  onChange: (members: GroupMember[]) => void;
  /**
   * Правящаяся группа. Её нельзя добавить в саму себя, поэтому она исключается
   * из списка выбираемых групп (цикл при этом всё равно отвергнет сервер).
   */
  excludeGroupId?: string;
  /** Область правящейся группы: выбранное из общих списков в проектной — `scope: global`. */
  groupScope?: GroupScope;
}
