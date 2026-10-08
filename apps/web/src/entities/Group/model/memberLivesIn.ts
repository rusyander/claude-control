import type { GroupScope, GroupMember } from '@agentdeck/contracts';

/** Где на деле живёт участник группы: своя область важнее области группы. */
export function memberLivesIn(
  groupScope: GroupScope | undefined,
  member: GroupMember,
): 'global' | 'project' {
  return (member.scope ?? groupScope)?.kind === 'project' ? 'project' : 'global';
}
