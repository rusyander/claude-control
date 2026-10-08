import type { GroupMember, GroupScope, GroupMemberKind } from '@agentdeck/contracts';
import { pickedMember } from '@entities/Group';
import { memberRef } from './groupAssistant';

/**
 * Проверенные ссылки → состав. Уже стоящий участник сохраняется как был (со
 * своей областью), новый берётся из общих списков — как при отметке рукой.
 */
export function membersFromRefs(
  refs: readonly string[],
  current: readonly GroupMember[],
  groupScope: GroupScope | undefined,
): GroupMember[] {
  return refs.map((ref) => {
    const existing = current.find((member) => memberRef(member) === ref);
    if (existing) return existing;
    const at = ref.indexOf(':');
    return pickedMember(
      groupScope,
      ref.slice(0, at) as GroupMemberKind,
      ref.slice(at + 1),
      'global',
    );
  });
}
