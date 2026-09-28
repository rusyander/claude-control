import type { GroupMember, GroupMemberKind, GroupScope } from '@agentdeck/contracts';
import type { AssistantOption, AssistantSpec } from '@shared/lib/assistant-fields';
import { pickedMember } from '@entities/Group';
import type { PickerItem } from './memberCatalog.types';

/** Ссылка на участника в ответе помощника: `вид:id` (id хука сам может нести двоеточия). */
export const memberRef = (member: { kind: GroupMemberKind; id: string }): string =>
  `${member.kind}:${member.id}`;

interface GroupAssistantInput {
  /** Всё, что можно отметить (`memberCatalog`). */
  catalog: readonly PickerItem[];
  /** Нынешний состав: участник вне каталога (локальный хук, проектный) тоже допустим. */
  members: readonly GroupMember[];
  projects: ReadonlyArray<{ path: string; name: string }>;
  /** Нынешняя привязка: путь, убранный из реестра, остаётся допустимым. */
  projectPaths: readonly string[];
}

function memberOptions(catalog: readonly PickerItem[], members: readonly GroupMember[]) {
  const options: AssistantOption[] = catalog.map((item) => ({
    value: memberRef(item),
    label: `${item.kind} · ${item.label}`,
  }));
  const known = new Set(options.map((option) => option.value));
  for (const member of members) {
    const ref = memberRef(member);
    if (!known.has(ref)) options.push({ value: ref, label: `${member.kind} · current member` });
    known.add(ref);
  }
  return options;
}

function projectOptions(input: GroupAssistantInput): AssistantOption[] {
  const options: AssistantOption[] = input.projects.map((project) => ({
    value: project.path,
    label: project.name,
  }));
  for (const path of input.projectPaths) {
    if (!options.some((option) => option.value === path)) {
      options.push({ value: path, label: 'bound, not in the project registry' });
    }
  }
  return options;
}

/** Каждое поле формы группы: тексты, состав и привязка к проектам. */
export function groupAssistantSpec(input: GroupAssistantInput) {
  return {
    name: { type: 'text', hint: 'Group name' },
    description: { type: 'text', hint: 'What this group is for' },
    when: {
      type: 'text',
      hint: 'When the group fits — one line; the chat picks the group by it on its own',
    },
    envText: {
      type: 'text',
      hint: 'Group environment variables, one per line as KEY=VALUE',
    },
    members: {
      type: 'choices',
      hint:
        'Group members — rules, skills, hooks, MCP servers, permissions and nested groups, ' +
        'written as kind:id. The order matters: members are walked in this order',
      options: memberOptions(input.catalog, input.members),
    },
    projectPaths: {
      type: 'choices',
      hint:
        'Projects the group is bound to, by absolute path: the group switches on by itself ' +
        'when an agent works in one of them',
      options: projectOptions(input),
    },
  } satisfies AssistantSpec;
}

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
