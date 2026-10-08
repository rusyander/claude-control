import type { GroupMember, GroupMemberKind, GroupScope } from '@agentdeck/contracts';

/**
 * Участник без поля `scope` живёт там же, где группа (так читает сервер,
 * `memberScope`). Поэтому ресурс, выбранный из ОБЩИХ каталогов в проектную
 * группу, обязан нести `scope: global` — голым он читался бы как проектный.
 */
export function pickedMember(
  groupScope: GroupScope | undefined,
  kind: GroupMemberKind,
  id: string,
  from: 'global' | 'project',
): GroupMember {
  return groupScope?.kind === 'project' && from === 'global'
    ? { kind, id, scope: { kind: 'global' } }
    : { kind, id };
}
