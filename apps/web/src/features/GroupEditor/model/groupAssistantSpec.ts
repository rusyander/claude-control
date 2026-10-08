import type { PickerItem } from './memberCatalog.types';
import type { GroupMember } from '@agentdeck/contracts';
import type { AssistantOption, AssistantSpec } from '@shared/lib/assistant-fields';
import { memberRef } from './groupAssistant';
import type { GroupAssistantInput } from './groupAssistant.types';

export function memberOptions(catalog: readonly PickerItem[], members: readonly GroupMember[]) {
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

export function projectOptions(input: GroupAssistantInput): AssistantOption[] {
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
