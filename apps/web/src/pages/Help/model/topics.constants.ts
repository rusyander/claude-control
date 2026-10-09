import type { HelpTopic } from './topics.types';
import { OverviewTopic } from '../topics/OverviewTopic/OverviewTopic';
import { SearchTopic } from '../topics/SearchTopic/SearchTopic';
import { AnalyticsTopic } from '../topics/AnalyticsTopic/AnalyticsTopic';
import { ChatTopic } from '../topics/ChatTopic/ChatTopic';
import { TestsTopic } from '../topics/TestsTopic/TestsTopic';
import { RulesTopic } from '../topics/RulesTopic/RulesTopic';
import { ClaudeMdTopic } from '../topics/ClaudeMdTopic/ClaudeMdTopic';
import { SkillsTopic } from '../topics/SkillsTopic/SkillsTopic';
import { CommandsTopic } from '../topics/CommandsTopic/CommandsTopic';
import { HooksTopic } from '../topics/HooksTopic/HooksTopic';
import { ScriptsTopic } from '../topics/ScriptsTopic/ScriptsTopic';
import { PluginsTopic } from '../topics/PluginsTopic/PluginsTopic';
import { McpTopic } from '../topics/McpTopic/McpTopic';
import { PermissionsTopic } from '../topics/PermissionsTopic/PermissionsTopic';
import { EnvTopic } from '../topics/EnvTopic/EnvTopic';
import { IntegrationsTopic } from '../topics/IntegrationsTopic/IntegrationsTopic';
import { ProjectsTopic } from '../topics/ProjectsTopic/ProjectsTopic';
import { GroupsTopic } from '../topics/GroupsTopic/GroupsTopic';
import { HistoryTopic } from '../topics/HistoryTopic/HistoryTopic';
import { WatcherTopic } from '../topics/WatcherTopic/WatcherTopic';
import { CompareTopic } from '../topics/CompareTopic/CompareTopic';
import { PortabilityTopic } from '../topics/PortabilityTopic/PortabilityTopic';
import { SettingsTopic } from '../topics/SettingsTopic/SettingsTopic';
import { EndpointsTopic } from '../topics/EndpointsTopic/EndpointsTopic';
import { DlpTopic } from '../topics/DlpTopic/DlpTopic';
import { PlatformTopic } from '../topics/PlatformTopic/PlatformTopic';
import { LocalModelsTopic } from '../topics/LocalModelsTopic/LocalModelsTopic';
import { KitTopic } from '../topics/KitTopic/KitTopic';
import { PromptsTopic } from '../topics/PromptsTopic/PromptsTopic';
import { ProvidersTopic } from '../topics/ProvidersTopic/ProvidersTopic';
import { PanelAgentTopic } from '../topics/PanelAgentTopic/PanelAgentTopic';
import { PhoneTopic } from '../topics/PhoneTopic/PhoneTopic';

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
 * topics/: индекс, адрес `?topic=` и переход к соседнему разделу подхватят его
 * сами. А вот кнопку «?» на самой странице нужно поставить руками —
 * `helpTopic` у её `PageHeader`. Автоматической она быть не может: заголовок
 * живёт в `shared/ui` и о справке не знает, а знать не должен — слои идут вниз.
 * Забыть её легко (так и случилось у истории, поиска и проектов), поэтому
 * проверяет `node tools/qa/check-help.mjs`: он обходит страницы и требует
 * кнопку там, где документ есть.
 */
export const HELP_GROUPS: HelpGroup[] = [
  {
    labelKey: 'nav.sectionMain',
    topics: [
      { id: 'overview', icon: 'overview', pagePath: '/', Content: OverviewTopic },
      { id: 'search', icon: 'search', pagePath: '/search', Content: SearchTopic },
      { id: 'analytics', icon: 'analytics', pagePath: '/analytics', Content: AnalyticsTopic },
      { id: 'chat', icon: 'chat', pagePath: '/chat', Content: ChatTopic },
      // Рабочее место тестировщика: своя страница, но объясняется рядом с чатом
      // намеренно — прогон кейсов ведёт тот же агент, что и разговор, и читать
      // эти два документа приходится подряд.
      { id: 'tests', icon: 'check', pagePath: '/tests', Content: TestsTopic },
    ],
  },
  {
    labelKey: 'nav.sectionBehavior',
    topics: [
      { id: 'rules', icon: 'rules', pagePath: '/rules', Content: RulesTopic },
      { id: 'claudeMd', icon: 'file', pagePath: '/claude-md', Content: ClaudeMdTopic },
      { id: 'skills', icon: 'skills', pagePath: '/skills', Content: SkillsTopic },
      { id: 'commands', icon: 'commands', pagePath: '/commands', Content: CommandsTopic },
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
      // Вкладка настроек, а не свой раздел: `pagePath` ведёт в «Настройки»,
      // где стоят карточки коннекторов. Кнопка «?» там уже есть — своя ей не
      // нужна, документов на одной странице может быть несколько.
      {
        id: 'integrations',
        icon: 'plug',
        pagePath: '/settings',
        Content: IntegrationsTopic,
      },
      { id: 'projects', icon: 'folder', pagePath: '/projects', Content: ProjectsTopic },
    ],
  },
  {
    labelKey: 'nav.sectionApp',
    topics: [
      { id: 'groups', icon: 'groups', pagePath: '/groups', Content: GroupsTopic },
      { id: 'history', icon: 'history', pagePath: '/history', Content: HistoryTopic },
      { id: 'compare', icon: 'swap', pagePath: '/compare', Content: CompareTopic },
      // Порядок тот же, что в боковом меню: паспорт среды стоит между
      // сравнением и настройками. Читают справку подряд, и документ про
      // «что доедет до другого CLI» осмысленно встретить сразу после
      // документа про «что у них разного».
      { id: 'portability', icon: 'file', pagePath: '/portability', Content: PortabilityTopic },
      { id: 'settings', icon: 'settings', pagePath: '/settings', Content: SettingsTopic },
      // Наблюдатель жил карточкой настроек и переехал на свою страницу
      // (09.10.2026) — документ стоит там же, где читатель искал его раньше.
      { id: 'watcher', icon: 'eye', pagePath: '/watcher', Content: WatcherTopic },
      // Свой эндпоинт — блок на странице настроек, но объясняет он окружение
      // чужих CLI, а не саму панель. Отдельным документом, потому что вопрос
      // «куда уходят данные» задают до того, как открывают настройки.
      { id: 'endpoints', icon: 'link', pagePath: '/settings', Content: EndpointsTopic },
      // Рядом со «своим эндпоинтом» намеренно: вопрос один и тот же — куда
      // уходят данные, — и читать эти два документа надо подряд.
      { id: 'dlp', icon: 'lock', pagePath: '/dlp', Content: DlpTopic },
      // Контур — третий документ того же вопроса: куда уходит запрос, если
      // моделью распоряжается не вендор, а компания.
      { id: 'platform', icon: 'flag', pagePath: '/platform', Content: PlatformTopic },
      // Сразу за контуром: локальная модель подключается к агентам именно контуром,
      // и читать про неё осмысленно, когда уже понятно, что такое контур.
      {
        id: 'localModels',
        icon: 'server',
        pagePath: '/local-models',
        Content: LocalModelsTopic,
      },
      // Сразу за локальными моделями: набор панели подключается к тем же агентам,
      // и Qwen Code получает его именно на локальной модели.
      { id: 'kit', icon: 'skills', pagePath: '/kit', Content: KitTopic },
      // После контура намеренно: три промпта из пяти существуют ради него, и
      // читать про тексты, которыми панель разговаривает с моделью, осмысленно
      // после того, как узнал, куда эти тексты уезжают. Вкладка настроек, а не
      // свой раздел, — `pagePath` ведёт в «Настройки».
      { id: 'prompts', icon: 'file', pagePath: '/settings', Content: PromptsTopic },
      // Единственный сквозной документ: он объясняет не свой раздел, а почему
      // набор разделов вообще меняется. Своей страницы у него нет, поэтому
      // `pagePath` ведёт в «Настройки» — там стоит переключатель провайдера.
      // Идёт ПОСЛЕ settings: по этому порядку читают справку подряд, и документ
      // про сам раздел должен встретиться раньше сквозного.
      { id: 'providers', icon: 'swap', pagePath: '/settings', Content: ProvidersTopic },
      // Окно агента есть на каждой странице, своего раздела у него нет: `pagePath`
      // ведёт на «Обзор», откуда окно открывают чаще всего.
      { id: 'panelAgent', icon: 'commands', pagePath: '/', Content: PanelAgentTopic },
      // Последним намеренно: телефон — окно во всё, что описано выше, и читать про
      // него осмысленно, когда разделы уже знакомы. Своей страницы у него нет:
      // `pagePath` ведёт в «Настройки», где стоит карточка «Удалённый доступ».
      { id: 'phone', icon: 'phone', pagePath: '/settings', Content: PhoneTopic },
    ],
  },
];

export const ALL_TOPICS = HELP_GROUPS.flatMap((group) => group.topics);
