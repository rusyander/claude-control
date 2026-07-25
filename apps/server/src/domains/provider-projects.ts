import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type {
  AppSettings,
  ProviderProjectInfo,
  ProviderProjectSection,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerProjectBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { isInsideProject } from './projects.ts';
import type { ProviderMcpTarget } from './provider-mcp.ts';
import type { ProviderEnvTarget } from './provider-env.ts';
import type { ProviderPermissionsTarget } from './provider-permissions.ts';
import type { ProviderInstructionsTarget } from './provider-instructions.ts';
import type { ProviderRulesTarget } from './provider-rules.ts';
import type { ProviderHooksTarget } from './provider-hooks.ts';
import type { ProviderPluginsTarget } from './provider-plugins.ts';
import type { ProviderSkillsTarget } from './provider-skills.ts';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2).
 *
 * Идея ровно та же, что у глобальных разделов (`instructionsFile`/`mcpConfig`),
 * только корень — не домашний каталог, а каталог ПРОЕКТА:
 *
 *  - Codex    — `<проект>/AGENTS.md` + `<проект>/.codex/config.toml` (TOML);
 *  - Gemini   — `<проект>/GEMINI.md` + `<проект>/.gemini/settings.json` (MCP и
 *               права/аппрувы) + `<проект>/.gemini/.env` (переменные окружения);
 *  - OpenCode — `<проект>/AGENTS.md` + `<проект>/opencode.json` (opencode-json);
 *  - Cursor   — `<проект>/.cursor/mcp.json` (JSON, адрес в `url`) + КАТАЛОГ
 *               правил `<проект>/.cursor/rules/*.mdc` (CURSOR-1).
 *
 * НОВЫХ ПАРСЕРОВ ЗДЕСЬ НЕТ. MCP читается и пишется теми же функциями
 * `domains/provider-mcp.ts` (json / toml-хирургия / opencode-json), переменные
 * окружения — `domains/provider-env.ts`, права — `domains/provider-permissions.ts`;
 * меняется только путь в соответствующей цели. Инструкции — обычный markdown через
 * safe-io. Значит и все защиты те же: бэкап + атомарная запись, сохранение
 * BOM/CRLF, round-trip-проверка до записи, fail-closed на нераспознанном формате.
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ. Относительные пути задаёт каталог провайдера, но каждый
 * собранный путь дополнительно проверяется `isInsideProject`: файл за пределами
 * каталога проекта не резолвится вовсе (`UnsafeProjectPathError`). Так проектный
 * раздел не сможет записать ничего в домашний каталог или соседний репозиторий,
 * даже если однажды в каталог попадёт путь вида `../../etc`.
 *
 * КОПИИ. Имя копии — `<id>-project-<basename>` (`providerProjectBackupName`):
 * иначе правка `<проект>/.codex/config.toml` попадала бы в ротацию глобального
 * `~/.codex/config.toml`. Восстановление копий провайдера и так запрещено.
 *
 * CLAUDE НЕ ЗАТРАГИВАЕТСЯ. У него собственный проектный уровень (CLAUDE.md +
 * .claude/settings.json + .mcp.json, права и хуки) на прежних маршрутах — он
 * сюда не попадает: `projectConfig` у Claude не задан, резолвер вернёт undefined.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
export interface ProviderProjectSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Путь вышел за пределы каталога проекта — запись запрещена (fail-closed). */
export class UnsafeProjectPathError extends Error {
  constructor(path: string) {
    super(`Путь выходит за пределы каталога проекта: ${path}`);
    this.name = 'UnsafeProjectPathError';
  }
}

/** Разрешённая цель проектного раздела активного провайдера. */
export interface ProviderProjectTarget {
  provider: ConfigProvider;
  /** Нормализованный корень проекта. */
  root: string;
  /** Файл инструкций проекта — если провайдер его документирует. */
  instructions?: { filePath: string; fileName: string };
  /**
   * Цель раздела инструкций-СПИСКОМ ССЫЛОК (AIDER-1/AIDER-4) — альтернатива
   * `instructions` там, где единого файла инструкций нет. Та же структура, что у
   * глобального раздела, поэтому домен `provider-instructions` работает без
   * изменений; `projectRoot` включает дополнительную проверку: перечисленный
   * файл открывается только если лежит ВНУТРИ проекта.
   */
  instructionsList?: ProviderInstructionsTarget;
  /**
   * Цель раздела инструкций-КАТАЛОГОМ ПРАВИЛ (CURSOR-1) — третья альтернатива
   * `instructions`. Та же структура, что у глобального раздела, поэтому домен
   * `provider-rules` работает без изменений; корень безопасности — сам каталог
   * правил, а он дополнительно проверен `resolveProjectFile` на выход за проект.
   */
  instructionsRules?: ProviderRulesTarget;
  /**
   * Цель MCP-раздела — та же структура, что у глобального универсального
   * раздела, поэтому читалки/писалки `provider-mcp` работают без изменений.
   */
  mcp?: ProviderMcpTarget;
  /** Цель раздела переменных окружения проекта (та же структура, что у глобальной). */
  env?: ProviderEnvTarget;
  /** Цель раздела прав/аппрувов проекта (та же структура, что у глобальной). */
  permissions?: ProviderPermissionsTarget;
  /**
   * Цель раздела ХУКОВ проекта (OPENCODE-3) — та же структура, что у глобального
   * раздела, поэтому домен `provider-hooks` работает без изменений.
   */
  hooks?: ProviderHooksTarget;
  /**
   * Цель раздела ПЛАГИНОВ проекта (OPENCODE-4) — та же структура, что у
   * глобального: каталог файлов `<проект>/.opencode/plugins` (он же корень
   * безопасности путей, и сам он проверен `resolveProjectFile`) плюс конфиг с
   * массивом `plugin`.
   */
  plugins?: ProviderPluginsTarget;
  /**
   * Цель раздела СКИЛЛОВ проекта (OPENCODE-5) — та же структура, что у
   * глобального: каталог `<проект>/.opencode/skills` (он же корень безопасности
   * путей, и сам он проверен `resolveProjectFile`). Список «прочих каталогов
   * загрузки» здесь пуст: на проектном уровне таких не задокументировано.
   */
  skills?: ProviderSkillsTarget;
}

/**
 * Собрать путь внутри проекта из относительного (разделитель — `/`) и убедиться,
 * что он не выходит за его пределы. Иначе — `UnsafeProjectPathError`.
 */
export function resolveProjectFile(root: string, relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  const filePath = join(root, ...segments);
  // Абсолютный «относительный» путь и любые `..` отсекаются одинаково.
  if (isAbsolute(relativePath) || !isInsideProject(root, filePath) || filePath === root) {
    throw new UnsafeProjectPathError(relativePath);
  }
  return filePath;
}

/**
 * Проектная цель активного провайдера — или `undefined`, если проектный уровень
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `projects` =
 * `ready` И задан `projectConfig`. Claude сюда не попадает (у него свои роуты).
 */
export function resolveProviderProjectTarget(
  store: ProviderProjectSettingsSource,
  projectPath: string,
): ProviderProjectTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.projects !== 'ready' || !provider.projectConfig) return undefined;

  const root = resolve(projectPath);
  const config = provider.projectConfig;

  const target: ProviderProjectTarget = { provider, root };

  if (config.instructions) {
    const filePath = resolveProjectFile(root, config.instructions);
    target.instructions = { filePath, fileName: basename(filePath) };
  }

  // Инструкции-списком (Aider): конфиг проекта тот же `.aider.conf.yml`, а
  // относительные записи `read` разрешаются от каталога проекта — он же корень
  // безопасности (перечисленный файл вне проекта раздел не открывает).
  if (config.instructionsList) {
    const filePath = resolveProjectFile(root, config.instructionsList.relativePath);
    target.instructionsList = {
      provider,
      format: config.instructionsList.format,
      scope: 'project',
      configPath: filePath,
      baseDir: root,
      projectRoot: root,
      backupName: providerProjectBackupName(provider.id, filePath),
    };
  }

  // Инструкции-КАТАЛОГОМ ПРАВИЛ (Cursor): каталог проекта `.cursor/rules`.
  // `resolveProjectFile` гарантирует, что сам каталог лежит внутри проекта, а
  // дальше границей служит уже он сам (домен `provider-rules` не выпускает
  // наружу ни `..`, ни абсолютный путь, ни ссылку в сегменте).
  if (config.instructionsRules) {
    const dirPath = resolveProjectFile(root, config.instructionsRules.relativeDir);
    target.instructionsRules = {
      provider,
      format: config.instructionsRules.format,
      scope: 'project',
      rulesDir: dirPath,
      backupPrefix: `${provider.id}-project-`,
    };
  }

  if (config.mcp) {
    const filePath = resolveProjectFile(root, config.mcp.relativePath);
    target.mcp = {
      provider,
      format: config.mcp.format,
      filePath,
      // На проектном уровне «детект» — существует ли сам каталог проекта.
      cliDetected: existsSync(root),
      jsonHttpUrlKey: config.mcp.jsonHttpUrlKey ?? 'httpUrl',
      // Копии проектных файлов отделены от глобальных префиксом `-project-`.
      backupName: providerProjectBackupName(provider.id, filePath),
    };
  }

  // Переменные окружения проекта — тот же адаптер формата, что и у глобального
  // раздела; включается только там, где проектный путь ЗАДОКУМЕНТИРОВАН (Gemini).
  if (config.env) {
    const filePath = resolveProjectFile(root, config.env.relativePath);
    target.env = {
      provider,
      format: config.env.format,
      filePath,
      cliDetected: existsSync(root),
      backupName: providerProjectBackupName(provider.id, filePath),
    };
  }

  // Права/аппрувы проекта — аналогично (Gemini: <проект>/.gemini/settings.json).
  if (config.permissions) {
    const filePath = resolveProjectFile(root, config.permissions.relativePath);
    target.permissions = {
      provider,
      format: config.permissions.format,
      filePath,
      cliDetected: existsSync(root),
      backupName: providerProjectBackupName(provider.id, filePath),
    };
  }

  // Хуки проекта (OPENCODE-3) — тот же адаптер и тот же файл, что у прав.
  if (config.hooks) {
    const filePath = resolveProjectFile(root, config.hooks.relativePath);
    target.hooks = {
      provider,
      format: config.hooks.format,
      scope: 'project',
      filePath,
      backupName: providerProjectBackupName(provider.id, filePath),
      // Снятие ключа с записи — свойство ФОРМАТА, а не уровня: если панель не
      // пишет `experimental.hook` глобально, то и в проекте не пишет.
      ...(provider.hooksConfig?.writeDisabledReason
        ? { writeDisabledReason: provider.hooksConfig.writeDisabledReason }
        : {}),
    };
  }

  // Плагины проекта (OPENCODE-4): каталог файлов + конфиг с массивом `plugin`.
  // Оба пути проверены `resolveProjectFile`; дальше границей служит сам каталог
  // (домен `provider-plugins` не выпускает наружу ни `..`, ни ссылку в сегменте).
  if (config.plugins) {
    target.plugins = {
      provider,
      format: config.plugins.format,
      scope: 'project',
      pluginsDir: resolveProjectFile(root, config.plugins.relativeDir),
      configPath: resolveProjectFile(root, config.plugins.relativePath),
      backupPrefix: `${provider.id}-project-`,
    };
  }

  // Скиллы проекта (OPENCODE-5): каталог `<проект>/.opencode/skills`. Дальше
  // границей служит он сам — домен `provider-skills` не выпускает наружу ни
  // `..`, ни ссылку в сегменте, ни путь формы, отличной от `<имя>/SKILL.md`.
  if (config.skills) {
    target.skills = {
      provider,
      format: config.skills.format,
      scope: 'project',
      skillsDir: resolveProjectFile(root, config.skills.relativeDir),
      backupPrefix: `${provider.id}-project-`,
      // Прочие каталоги загрузки — понятие ГЛОБАЛЬНОЕ (домашний каталог).
      externalDirs: [],
      // Предел описания — свойство CLI, а не уровня: в проекте он тот же.
      ...(provider.skillsConfig?.descriptionMax
        ? { descriptionMax: provider.skillsConfig.descriptionMax }
        : {}),
    };
  }

  return target;
}

/** Какие проектные разделы есть у цели — по ним клиент строит табы. */
export function providerProjectSections(target: ProviderProjectTarget): ProviderProjectSection[] {
  const sections: ProviderProjectSection[] = [];
  if (target.instructions) sections.push('instructions');
  if (target.instructionsList) sections.push('instructionsList');
  if (target.instructionsRules) sections.push('instructionsRules');
  if (target.mcp) sections.push('mcp');
  if (target.env) sections.push('env');
  if (target.permissions) sections.push('permissions');
  if (target.hooks) sections.push('hooks');
  if (target.plugins) sections.push('plugins');
  if (target.skills) sections.push('skills');
  return sections;
}

/** Сводка проектного уровня для клиента. */
export function providerProjectInfo(target: ProviderProjectTarget): ProviderProjectInfo {
  return {
    providerId: target.provider.id,
    providerName: target.provider.name,
    projectPath: target.root,
    sections: providerProjectSections(target),
    instructionsFileName: target.instructions?.fileName,
    instructionsPath: target.instructions?.filePath,
    instructionsListFormat: target.instructionsList?.format,
    instructionsListPath: target.instructionsList?.configPath,
    instructionsRulesFormat: target.instructionsRules?.format,
    instructionsRulesDir: target.instructionsRules?.rulesDir,
    mcpFormat: target.mcp?.format,
    mcpPath: target.mcp?.filePath,
    envFormat: target.env?.format,
    envPath: target.env?.filePath,
    permissionsFormat: target.permissions?.format,
    permissionsPath: target.permissions?.filePath,
    hooksFormat: target.hooks?.format,
    hooksPath: target.hooks?.filePath,
    skillsFormat: target.skills?.format,
    skillsDir: target.skills?.skillsDir,
    // Проектные плагины бывают только у OpenCode (у Kimi они домашние и только
    // для чтения) — сужение честное, а не «лишь бы собралось».
    pluginsFormat: target.plugins?.format === 'opencode-plugins' ? 'opencode-plugins' : undefined,
    pluginsDir: target.plugins?.pluginsDir,
    pluginsConfigPath: target.plugins?.configPath,
  };
}

/** Прочитать файл инструкций проекта. Нет файла → пустой контент, `exists:false`. */
export function readProviderProjectInstructions(target: ProviderProjectTarget): {
  content: string;
  exists: boolean;
} {
  const filePath = requireInstructions(target).filePath;
  return { content: readTextFile(filePath), exists: existsSync(filePath) };
}

/**
 * Записать файл инструкций проекта: бэкап + атомарно + создание каталога.
 * `preserveForm` по умолчанию — текст приходит из <textarea> (браузер шлёт CRLF),
 * форма существующего файла сохраняется.
 */
export function writeProviderProjectInstructions(
  target: ProviderProjectTarget,
  content: string,
  backupDir: string | undefined,
): string | undefined {
  const { filePath } = requireInstructions(target);
  return writeTextFile(filePath, content, {
    backupDir,
    backupName: providerProjectBackupName(target.provider.id, filePath),
  });
}

/** Раздел инструкций проекта обязан быть у цели — иначе это ошибка маршрута. */
function requireInstructions(target: ProviderProjectTarget): {
  filePath: string;
  fileName: string;
} {
  if (!target.instructions) {
    throw new Error('У активного провайдера нет проектного файла инструкций.');
  }
  return target.instructions;
}
