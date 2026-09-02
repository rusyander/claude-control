import type { ReactNode } from 'react';
import type { Hook, ProjectLocalConfig, ProjectRuleFile, Skill } from '@claude-control/contracts';

export interface ProjectLocalConfigViewProps {
  /** Ответ `GET /projects/:id/local` или `GET /projects/local?path=…`. */
  config: ProjectLocalConfig;
  /**
   * Компактный режим для карточки группы: строка счётчиков и кнопка, которая
   * раскрывает полный набор. Без него все три раздела видны сразу.
   */
  compact?: boolean;
}

export interface ProjectLocalSectionProps {
  title: string;
  count: number;
  /** Что написать вместо списка, когда раздела в проекте нет. */
  empty: string;
  children: ReactNode;
}

export interface SkillRowProps {
  skill: Skill;
}

export interface HookRowProps {
  hook: Hook;
}

export interface RuleRowProps {
  rule: ProjectRuleFile;
}
