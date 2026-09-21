import { join } from 'node:path';
import type { ClaudePaths } from '@agentdeck/contracts';
import type { EnvScope } from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';
import { resolveProviderEnvTargetFor, type ProviderEnvTarget } from '../provider-env.ts';
import { resolveProviderHooksTargetFor } from '../provider-hooks/target.ts';
import type { ProviderHooksTarget } from '../provider-hooks.ts';
import {
  resolveProviderInstructionsTargetFor,
  type ProviderInstructionsTarget,
} from '../provider-instructions.ts';
import { resolveProviderMcpTargetFor } from '../provider-mcp/target.ts';
import type { ProviderMcpTarget } from '../provider-mcp.ts';
import { resolveProviderPermissionsTargetFor } from '../provider-permissions/target.ts';
import type { ProviderPermissionsTarget } from '../provider-permissions.ts';
import { resolveProviderPluginsTargetFor } from '../provider-plugins/paths.ts';
import type { ProviderPluginsTarget } from '../provider-plugins.ts';
import { providerProjectTargetFor } from '../provider-projects.ts';
import { resolveProviderRulesTargetFor } from '../provider-rules/paths.ts';
import type { ProviderRulesTarget } from '../provider-rules.ts';
import { resolveProviderSkillsTargetFor } from '../provider-skills/paths.ts';
import type { ProviderSkillsTarget } from '../provider-skills.ts';
import { resolveProjectPaths } from '../projects.ts';

/**
 * Уровень записи: где у провайдера лежат его разделы — в доме или в проекте.
 *
 * Обе половины переноса (импорт и эмиссия) спрашивают ОДИН резолвер, и знает он
 * ровно одну ветку — по УРОВНЮ. Ветки по идентификатору CLI здесь нет и быть не
 * может: чем отличаются девять чужих, говорит каталог возможностей, а
 * относительные пути проектного уровня — `provider.projectConfig`.
 *
 * Почему не «как глобальный, только корень другой»: у провайдера без
 * `projectConfig` проектных путей НЕ ЗАДОКУМЕНТИРОВАНО, и подставить ему дом
 * значило бы записать проектную настройку туда, где она действует на все
 * проекты сразу. Такой провайдер отвечает `supported: false` с причиной, а
 * перенос на этот уровень отказывается (П2.5, критерий 2).
 */

/**
 * Разрешённые разделы одного провайдера на одном уровне.
 *
 * Поля — ровно те же структуры целей, с которыми работают домены разделов
 * (`provider-mcp`, `provider-hooks`, …): второго построителя путей партия не
 * заводит, и проектная цель собирается тем же `providerProjectTargetFor`,
 * которым её собирают проектные маршруты панели.
 */
export interface SectionTargets {
  readonly scope: EnvScope;
  /** Корень уровня: дом провайдера или каталог проекта. Не прочитан — пустая строка. */
  readonly root: string;
  /** Знает ли панель этот уровень у этого провайдера. */
  readonly supported: boolean;
  /**
   * Разделы этого уровня описаны СОБСТВЕННОЙ раскладкой провайдера, а не
   * универсальными целями ниже.
   *
   * Такой сегодня один — Claude в проекте: его `CLAUDE.md`, `.claude/` и
   * `.mcp.json` читают и пишут его же половины по `claudeProjectPaths`, и
   * универсальных целей в этой структуре нет вовсе. Флаг нужен, чтобы «целей
   * нет» не прочиталось как «разделов на этом уровне нет»: это разные вещи, и
   * вторая обнулила бы профиль цели у единственного CLI, чей проектный уровень
   * полон.
   */
  readonly ownLayout: boolean;
  /** Почему не знает — фраза человеку; заполнена только при `supported: false`. */
  readonly why?: string;
  /** Один файл инструкций (`AGENTS.md`, `GEMINI.md`, …). */
  readonly instructionsFile?: string;
  readonly instructionsList?: ProviderInstructionsTarget;
  readonly instructionsRules?: ProviderRulesTarget;
  readonly mcp?: ProviderMcpTarget;
  readonly env?: ProviderEnvTarget;
  readonly permissions?: ProviderPermissionsTarget;
  readonly hooks?: ProviderHooksTarget;
  readonly skills?: ProviderSkillsTarget;
  readonly plugins?: ProviderPluginsTarget;
  /** Слэш-команды: каталог и формат. Раздел файловый, цели-структуры у него нет. */
  readonly commands?: {
    readonly dir: string;
    readonly config: NonNullable<ConfigProvider['commandsConfig']>;
  };
}

/** Что резолверу нужно знать сверх провайдера и уровня. */
export interface SectionTargetsOptions {
  /** Пользовательский каталог конфигурации; уважает его только Claude. */
  readonly override?: string;
  /** Корень проекта — обязателен на уровне проекта и не значит ничего на глобальном. */
  readonly projectRoot?: string;
}

/**
 * Уровень проекта потребовали, а корня не назвали.
 *
 * Не пустой ответ и не подстановка дома: перенос без корня проекта записал бы
 * проектные настройки в глобальный уровень, и человек узнал бы об этом по
 * изменившемуся поведению ВСЕХ своих проектов.
 */
export class ProjectRootRequiredError extends Error {
  constructor() {
    super('Уровень проекта требует корня проекта, а он не назван.');
    this.name = 'ProjectRootRequiredError';
  }
}

/** Перенос на уровень проекта туда, где этого уровня у провайдера нет. */
export class ProjectLevelUnsupportedError extends Error {
  readonly providerId: string;

  constructor(providerId: string, why: string) {
    super(why);
    this.name = 'ProjectLevelUnsupportedError';
    this.providerId = providerId;
  }
}

/**
 * Провайдеры, чей проектный уровень панель знает СВОЕЙ раскладкой, а не
 * относительными путями каталога.
 *
 * Такой сегодня один — Claude: его проект это `CLAUDE.md` в корне репозитория
 * плюс `.claude/` и `.mcp.json`, и читают его собственные разделы панели
 * (`domains/project-local.ts`, маршруты `/api/projects/:id/*`). Список — реестр
 * ровно того же рода, что `import/index.ts` и `emit/index.ts`: единственное
 * место половины, где идентификатор CLI решает, какой раскладкой пользоваться.
 */
const OWN_PROJECT_LAYOUT: Readonly<Record<string, true>> = { claude: true };

/** Знает ли панель проектный уровень этого провайдера — и если нет, то почему. */
export function projectSupport(provider: ConfigProvider): {
  supported: boolean;
  why?: string;
} {
  if (OWN_PROJECT_LAYOUT[provider.id]) return { supported: true };
  if (provider.capabilities.projects === 'ready' && provider.projectConfig) {
    return { supported: true };
  }
  return {
    supported: false,
    why: `${provider.name} не документирует настроек уровня проекта — переносить их некуда`,
  };
}

/**
 * Разделы провайдера на названном уровне.
 *
 * Глобальный уровень отдаётся ровно теми же резолверами, что и до П2.5:
 * поведение не меняется ни на байт. Проектный собирается из
 * `provider.projectConfig` через `resolveProjectFile` — тот самый, что проверяет
 * `isInsideProject` и отказывает пути за пределами корня.
 */
export function sectionTargets(
  provider: ConfigProvider,
  scope: EnvScope,
  options: SectionTargetsOptions = {},
): SectionTargets {
  return scope === 'project'
    ? projectTargets(provider, options.projectRoot)
    : globalTargets(provider, options.override);
}

function globalTargets(provider: ConfigProvider, override: string | undefined): SectionTargets {
  const commandsConfig = provider.commandsConfig;
  return {
    scope: 'global',
    root: globalRoot(provider, override),
    supported: true,
    ownLayout: false,
    ...(provider.instructionsFile && provider.capabilities.globalInstructions === 'ready'
      ? { instructionsFile: provider.instructionsFile(override) }
      : {}),
    instructionsList: resolveProviderInstructionsTargetFor(provider, override),
    instructionsRules: resolveProviderRulesTargetFor(provider, override),
    mcp: resolveProviderMcpTargetFor(provider, override),
    env: resolveProviderEnvTargetFor(provider, override),
    permissions: resolveProviderPermissionsTargetFor(provider, override),
    hooks: resolveProviderHooksTargetFor(provider, override),
    skills: resolveProviderSkillsTargetFor(provider, override),
    plugins: resolveProviderPluginsTargetFor(provider, override),
    ...(commandsConfig ? { commands: { dir: commandsConfig.dir(), config: commandsConfig } } : {}),
  };
}

function projectTargets(provider: ConfigProvider, projectRoot: string | undefined): SectionTargets {
  if (!projectRoot) throw new ProjectRootRequiredError();

  const support = projectSupport(provider);
  if (!support.supported) {
    return {
      scope: 'project',
      root: projectRoot,
      supported: false,
      ownLayout: false,
      why: support.why,
    };
  }

  // Claude сюда доходит только вопросом «поддержан ли уровень»: его разделы
  // читают и пишут собственные половины (`import/claude.ts`, `emit/claude.ts`)
  // по `claudeProjectPaths`, а универсальных целей у него нет вовсе.
  const target = providerProjectTargetFor(provider, projectRoot);
  if (!target) return { scope: 'project', root: projectRoot, supported: true, ownLayout: true };

  return {
    scope: 'project',
    root: target.root,
    supported: true,
    ownLayout: false,
    ...(target.instructions ? { instructionsFile: target.instructions.filePath } : {}),
    instructionsList: target.instructionsList,
    instructionsRules: target.instructionsRules,
    mcp: target.mcp,
    env: target.env,
    permissions: target.permissions,
    hooks: target.hooks,
    skills: target.skills,
    plugins: target.plugins,
    // Слэш-команд проектного уровня не документирует ни один из девяти: каталог
    // команд у всех домашний. Придумать ему проектный путь значило бы записать
    // файл, которого CLI не прочитает.
  };
}

/**
 * Корень дома. У провайдера-данных `paths()` бросает (файлы читаются
 * fail-closed) — это пустой корень, а не падение: каждый раздел назовёт свою
 * причину сам.
 */
function globalRoot(provider: ConfigProvider, override: string | undefined): string {
  try {
    return provider.paths(override).root;
  } catch {
    return '';
  }
}

/**
 * Раскладка Claude на одном уровне.
 *
 * Глобальная приезжает `detectClaudeLocation` и уже имеет этот вид; проектная
 * собирается здесь. Отличие не только в корне: `CLAUDE.md` проекта лежит в
 * корне РЕПОЗИТОРИЯ, а не внутри `.claude/`, и файла секретов панели на этом
 * уровне нет вовсе.
 */
export interface ClaudeLevelPaths extends Omit<ClaudePaths, 'secretsEnv'> {
  /** Файл секретов — понятие панели и её дома; у проекта его нет. */
  readonly secretsEnv?: string;
  /**
   * Корень, в котором CLI ищет файлы инструкций. У дома это сам каталог
   * конфигурации, у проекта — корень РЕПОЗИТОРИЯ. Отдельным полем, а не
   * `dirname(claudeMd)`: имя файла перестало быть константой (П2.7), и у проекта
   * на `.claude/CLAUDE.md` тот вывод уводил поиск на уровень вниз.
   */
  readonly instructionsRoot: string;
}

/**
 * Пути Claude внутри проекта. Строятся от `resolveProjectPaths` — того же
 * построителя, которым пользуются проектные маршруты панели: второй разошёлся бы
 * с первым молча, и панель показывала бы один файл, а перенос правил другой.
 */
export function claudeProjectPaths(projectRoot: string): ClaudeLevelPaths {
  const paths = resolveProjectPaths(projectRoot);
  const dir = join(paths.root, '.claude');
  return {
    root: dir,
    instructionsRoot: paths.root,
    settings: paths.settings,
    settingsLocal: paths.settingsLocal,
    claudeMd: paths.claudeMd,
    skills: join(dir, 'skills'),
    hooks: join(dir, 'hooks'),
    mcpConfig: paths.mcpConfig,
    // Данные самой панели (группы, связи) живут в её доме и на уровень проекта
    // не опускаются; поле остаётся ради одной формы с глобальной раскладкой.
    appData: join(dir, 'agentdeck'),
  };
}
