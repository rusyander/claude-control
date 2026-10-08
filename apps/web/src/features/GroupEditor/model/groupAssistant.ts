import type { GroupMemberKind } from '@agentdeck/contracts';

/** Ссылка на участника в ответе помощника: `вид:id` (id хука сам может нести двоеточия). */
export const memberRef = (member: { kind: GroupMemberKind; id: string }): string =>
  `${member.kind}:${member.id}`;
