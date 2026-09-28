import type { GroupMember } from '@agentdeck/contracts';
import type { GroupMemberBrief } from '@entities/Group';
import type { MemberLine } from './model/useMemberLines';

export interface GroupMemberRowProps {
  member: GroupMember;
  line: MemberLine;
  /** Описание с сервера — из файла участника там, где он лежит. */
  brief?: GroupMemberBrief;
  /** Описания с сервера ещё читаются. */
  isReading: boolean;
  /** Сервер назвал участника в `pending`: описание пишется в фоне. */
  isPending?: boolean;
}
