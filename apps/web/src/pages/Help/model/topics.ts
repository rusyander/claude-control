import type { ComponentType } from 'react';
import type { IconName } from '@shared/ui/icon';
import { OverviewTopic } from '../topics/OverviewTopic';
import { AnalyticsTopic } from '../topics/AnalyticsTopic';
import { ChatTopic } from '../topics/ChatTopic';
import { RulesTopic } from '../topics/RulesTopic';
import { ClaudeMdTopic } from '../topics/ClaudeMdTopic';
import { SkillsTopic } from '../topics/SkillsTopic';
import { HooksTopic } from '../topics/HooksTopic';
import { ScriptsTopic } from '../topics/ScriptsTopic';
import { PluginsTopic } from '../topics/PluginsTopic';
import { McpTopic } from '../topics/McpTopic';
import { PermissionsTopic } from '../topics/PermissionsTopic';
import { EnvTopic } from '../topics/EnvTopic';
import { GroupsTopic } from '../topics/GroupsTopic';
import { SettingsTopic } from '../topics/SettingsTopic';

export { HELP_ROUTE } from '@shared/config/routes';

export interface HelpTopic {
  /** Идентификатор в адресе: /help?topic=rules. */
  id: string;
  icon: IconName;
  /** Раздел панели, к которому относится документ. */
  pagePath: string;
  /** Документ раздела. Тексты берутся из словаря help.topics.<id>. */
  Content: ComponentType;
}

export interface HelpGroup {
  /** Ключ подписи группы — тот же, что у секций бокового меню. */
  labelKey: string;
  topics: HelpTopic[];
}

/**
 * Разделы справки сгруппированы ровно так же, как пункты бокового меню:
 * читатель ищет объяснение там же, где привык искать сам раздел.
 *
 * Добавить документ — дописать сюда запись и положить рядом компонент в
 * topics/. Ничего другого править не нужно: индекс, адрес, переход к соседнему
 * разделу и кнопка «?» на странице подхватят его сами.
 */
export const HELP_GROUPS: HelpGroup[] = [
  {
    labelKey: 'nav.sectionMain',
    topics: [
      { id: 'overview', icon: 'overview', pagePath: '/', Content: OverviewTopic },
      { id: 'analytics', icon: 'analytics', pagePath: '/analytics', Content: AnalyticsTopic },
      { id: 'chat', icon: 'chat', pagePath: '/chat', Content: ChatTopic },
    ],
  },
  {
    labelKey: 'nav.sectionBehavior',
    topics: [
      { id: 'rules', icon: 'rules', pagePath: '/rules', Content: RulesTopic },
      { id: 'claudeMd', icon: 'file', pagePath: '/claude-md', Content: ClaudeMdTopic },
      { id: 'skills', icon: 'skills', pagePath: '/skills', Content: SkillsTopic },
      { id: 'hooks', icon: 'hooks', pagePath: '/hooks', Content: HooksTopic },
      { id: 'scripts', icon: 'scripts', pagePath: '/scripts', Content: ScriptsTopic },
      { id: 'plugins', icon: 'plugins', pagePath: '/plugins', Content: PluginsTopic },
    ],
  },
  {
    labelKey: 'nav.sectionIntegrations',
    topics: [
      { id: 'mcp', icon: 'mcp', pagePath: '/mcp', Content: McpTopic },
      {
        id: 'permissions',
        icon: 'permissions',
        pagePath: '/permissions',
        Content: PermissionsTopic,
      },
      { id: 'env', icon: 'env', pagePath: '/env', Content: EnvTopic },
    ],
  },
  {
    labelKey: 'nav.sectionApp',
    topics: [
      { id: 'groups', icon: 'groups', pagePath: '/groups', Content: GroupsTopic },
      { id: 'settings', icon: 'settings', pagePath: '/settings', Content: SettingsTopic },
    ],
  },
];

const ALL_TOPICS = HELP_GROUPS.flatMap((group) => group.topics);

export function findHelpTopic(id: string | undefined): HelpTopic | undefined {
  return id ? ALL_TOPICS.find((topic) => topic.id === id) : undefined;
}

/** Есть ли для раздела панели документ справки — по этому решается кнопка «?». */
export function findTopicByPagePath(pagePath: string): HelpTopic | undefined {
  return ALL_TOPICS.find((topic) => topic.pagePath === pagePath);
}

/**
 * Соседи по порядку из HELP_GROUPS — для перехода в конце документа.
 * Порядок сквозной, границы групп не мешают: справку читают подряд.
 */
export function findTopicNeighbours(id: string): {
  prev?: HelpTopic;
  next?: HelpTopic;
} {
  const index = ALL_TOPICS.findIndex((topic) => topic.id === id);
  if (index < 0) return {};
  return { prev: ALL_TOPICS[index - 1], next: ALL_TOPICS[index + 1] };
}
