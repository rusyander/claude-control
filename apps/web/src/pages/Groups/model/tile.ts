/**
 * Порядок видов в строке состава: чем чаще участник, тем левее. Последние три
 * встречаются только у находок обнаружения — их состав шире состава группы.
 */
export const MEMBER_KIND_ORDER = [
  'skill',
  'rule',
  'hook',
  'mcp',
  'permission',
  'group',
  'command',
  'agent',
  'instructions',
] as const;

export type TileMemberKind = (typeof MEMBER_KIND_ORDER)[number];

export interface KindCount {
  kind: TileMemberKind;
  count: number;
}

/** «скилл 1 · хуков 17 · серверов 3»: состав по видам, пустые виды не называются. */
export function countMembersByKind(members: readonly { kind: string }[]): KindCount[] {
  return MEMBER_KIND_ORDER.map((kind) => ({
    kind,
    count: members.filter((member) => member.kind === kind).length,
  })).filter((item) => item.count > 0);
}
