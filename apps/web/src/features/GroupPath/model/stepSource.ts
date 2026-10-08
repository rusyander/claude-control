import { scopeOf } from '@agentdeck/contracts';
import type { SourceContext, StepSource } from './stepSource.types';

export function skillSource(skillId: string, { group, ourSkills }: SourceContext): StepSource {
  if (skillId.includes(':')) {
    return { kind: 'plugin-skill', id: skillId, plugin: skillId.split(':')[0] };
  }
  const member = group.members.find((item) => item.kind === 'skill' && item.id === skillId);
  const scope = member?.scope ?? scopeOf(group);
  if (scope.kind === 'project') {
    return { kind: 'project-skill', id: skillId, project: scope.path, provider: scope.provider };
  }
  if (!ourSkills) return { kind: 'skill', id: skillId };
  return { kind: ourSkills.has(skillId) ? 'our-skill' : 'foreign-skill', id: skillId };
}
