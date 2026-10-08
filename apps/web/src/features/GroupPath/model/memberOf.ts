import type { GroupMembersView, DescribedKind, MemberDescription } from '@agentdeck/contracts';

export function memberOf(
  view: GroupMembersView | undefined,
  kind: DescribedKind,
  id: string,
): MemberDescription | undefined {
  return view?.members.find((member) => member.kind === kind && member.id === id);
}
