import { scopeOf, type Group, type PathEntry, type PathResourceType } from '@agentdeck/contracts';

/**
 * Откуда строка пути — метка строки и первая строка окна шага. Наш скилл лежит
 * в каталоге скиллов провайдера, скилл проекта — в его `.claude`, скилл плагина
 * приходит с плагином, чужой — ни в одном из наших списков (другой провайдер,
 * удалён). Свой шаг человека — промпт, который хранит панель, или ресурс, в
 * который его превратили.
 */
export type StepSourceKind =
  | 'builtin'
  | 'our-skill'
  | 'project-skill'
  | 'plugin-skill'
  | 'foreign-skill'
  | 'skill'
  | 'prompt'
  | 'hook'
  | 'rule'
  | 'script';

export interface StepSource {
  kind: StepSourceKind;
  /** Скилл, хук или правило, о котором строка; у стадии и промпта нет. */
  id?: string;
  /** Плагин скилла `plugin:skill`. */
  plugin?: string;
  /** Проект, в котором лежит скилл проекта или ресурс шага проектной группы. */
  project?: string;
  provider?: string;
  resourceType?: PathResourceType;
}

export interface SourceContext {
  group: Pick<Group, 'scope' | 'members'>;
  /** Id скиллов из общего каталога; `undefined` — список ещё грузится. */
  ourSkills: Set<string> | undefined;
}

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

export interface SourcePaths {
  skills: string;
  settings: string;
  claudeMd: string;
  appData: string;
  hooks: string;
}

/** Файл, где строка живёт на диске; у стадии и скилла плагина пути нет. */
export function sourceFile(
  source: StepSource,
  paths: SourcePaths | undefined,
  hookScript?: string,
): string | undefined {
  if (source.project) return projectFile(source, source.project);
  if (!paths) return undefined;
  // Чужого скилла в нашем каталоге нет — путь туда был бы выдумкой.
  if (source.kind === 'our-skill' || source.kind === 'skill') {
    return joinPath(paths.skills, source.id ?? '', 'SKILL.md');
  }
  if (source.kind === 'prompt') return joinPath(paths.appData, 'state.json');
  if (source.kind === 'hook') return hookScript ?? paths.settings;
  if (source.kind === 'rule') return paths.claudeMd;
  if (source.kind === 'script') return joinPath(paths.hooks, source.id ?? '');
  return undefined;
}

/**
 * Файл строки в проекте. Панель знает раскладку только `.claude` (Claude):
 * у проекта другой CLI путь был бы выдумкой — пути нет.
 */
function projectFile(source: StepSource, project: string): string | undefined {
  if (source.provider !== 'claude') return undefined;
  const id = source.id ?? '';
  if (source.kind === 'project-skill')
    return joinPath(project, '.claude', 'skills', id, 'SKILL.md');
  if (source.kind === 'rule') return joinPath(project, '.claude', 'rules', `${id}.md`);
  if (source.kind === 'hook') return joinPath(project, '.claude', 'settings.json');
  if (source.kind === 'script') return joinPath(project, '.claude', 'hooks', id);
  return undefined;
}

/** Склейка пути тем разделителем, каким записана основа: Windows-путь остаётся Windows-путём. */
export function joinPath(base: string, ...parts: string[]): string {
  const separator = base.includes('\\') ? '\\' : '/';
  const trimmed = base.replace(/[\\/]+$/, '');
  return [trimmed, ...parts.filter(Boolean)].join(separator);
}
