import type { PathEntry } from '@agentdeck/contracts';
import type { SourceContext, StepSource } from './stepSource.types';
import { scopeOf } from '@agentdeck/contracts';
import { skillSource } from './stepSource';

export function entrySource(entry: PathEntry, context: SourceContext): StepSource {
  if (entry.kind === 'builtin') return { kind: 'builtin' };
  if (entry.kind === 'skill-step') return skillSource(entry.skillId, context);
  const resource = entry.step.resource;
  if (!resource) return { kind: 'prompt' };
  if (resource.type === 'skill') {
    return { ...skillSource(resource.id, context), resourceType: 'skill' };
  }
  // Правило, хук и скрипт шага проектной группы лежат в `.claude` её проекта
  // (`promote.ts`): без области окно шага называло общие CLAUDE.md и settings.json.
  const member = context.group.members.find(
    (item) => item.kind === resource.type && item.id === resource.id,
  );
  const scope = member?.scope ?? scopeOf(context.group);
  return {
    kind: resource.type,
    id: resource.id,
    resourceType: resource.type,
    ...(scope.kind === 'project' ? { project: scope.path, provider: scope.provider } : {}),
  };
}
