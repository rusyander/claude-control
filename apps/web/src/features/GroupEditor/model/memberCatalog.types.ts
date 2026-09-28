import type { GroupMemberKind } from '@agentdeck/contracts';

/** Строка сводного списка: сущность любого вида под общим подписанным видом. */
export interface PickerItem {
  kind: GroupMemberKind;
  id: string;
  label: string;
}

/** Списки сущностей, из которых собирается выбор участников группы. */
export interface MemberSources {
  rules: ReadonlyArray<{ id: string; title: string }>;
  skills: ReadonlyArray<{ id: string; name: string }>;
  hooks: ReadonlyArray<{ id: string; event: string; matcher?: string; source?: string }>;
  servers: ReadonlyArray<{ id: string; name: string }>;
  permissions: ReadonlyArray<{ id: string; decision: string; pattern: string }>;
  groups: ReadonlyArray<{ id: string; name: string }>;
}
