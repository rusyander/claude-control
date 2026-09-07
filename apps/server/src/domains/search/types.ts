import type {
  ClaudePaths,
  EnvVar,
  Group,
  Hook,
  McpServer,
  PermissionRule,
  Plugin,
  ProjectTestCase,
  Rule,
  Skill,
  UniversalMcpServer,
} from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import type { ScriptFile } from '../scripts.ts';

/**
 * Разделы АКТИВНОГО провайдера (не Claude), которые панель реально редактирует.
 * Значения переменных окружения сюда НЕ кладём — только имена ключей.
 */
export interface ProviderSearchInputs {
  providerId: string;
  providerName: string;
  /** Файл глобальных инструкций: имя и содержимое (ищем по тексту). */
  instructions?: { fileName: string; content: string };
  mcpServers: UniversalMcpServer[];
  /** ТОЛЬКО имена ключей: значения переменных в индекс поиска не попадают. */
  envKeys: string[];
  /**
   * Права провайдера как плоские пары «ключ → значение»: модели у CLI разные
   * (Codex — approval/sandbox, Gemini — режим аппрувов и списки инструментов),
   * а поиску нужен один общий вид.
   */
  permissions?: Array<{ key: string; value: string }>;
}

/** Кейс проекта в индексе поиска: сам кейс и группа, в которой он лежит. */
export interface SearchTestCase {
  groupId: string;
  groupTitle: string;
  testCase: ProjectTestCase;
}

/** Собранные разделы. Держим их отдельным типом, чтобы фильтр не зависел от источника данных. */
export interface SearchInputs {
  rules: Rule[];
  hooks: Hook[];
  skills: Skill[];
  scripts: ScriptFile[];
  permissions: PermissionRule[];
  envVars: EnvVar[];
  mcpServers: McpServer[];
  plugins: Plugin[];
  /** Группы панели: у них нет файлов Claude Code, поэтому они есть при любом провайдере. */
  groups: Group[];
  /** Разделы активного провайдера — задано, только когда активен НЕ Claude. */
  provider?: ProviderSearchInputs;
  /**
   * Кейсы открытого проекта. Есть, только когда запрос назвал проект: кейсы
   * лежат в самом проекте, и «глобального» набора у них нет.
   */
  tests?: SearchTestCase[];
}

/** Откуда читать разделы — пути конфигурации и хранилище состояния панели. */
export interface SearchSources {
  paths: ClaudePaths;
  store: AppStore;
  /** Открытый проект: только для него ищутся тест-кейсы. */
  projectPath?: string;
}
