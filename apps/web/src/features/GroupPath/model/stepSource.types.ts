import type { Group, PathResourceType } from '@agentdeck/contracts';

export interface SourceContext {
  group: Pick<Group, 'scope' | 'members'>;
  /** Id скиллов из общего каталога; `undefined` — список ещё грузится. */
  ourSkills: Set<string> | undefined;
}

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
