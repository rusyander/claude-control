import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudePaths, SlashCommand } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { readSkills, SKILLS_DISABLED_DIR } from '../skills.ts';
import { FILE_LIMIT, isDirectory, readJson } from './io.ts';
import { commandFiles, sortCommands } from './list.ts';
import { readMdCommand, trim } from './parse.ts';

/**
 * Источники команд Claude: скиллы пользователя, файлы `commands/**` и всё, что
 * приносят установленные плагины. Встроенные команды CLI сюда не входят — файла
 * у них нет, их каталог ведёт клиент панели.
 */
export function readClaudeCommands(
  paths: ClaudePaths,
  store: AppStore,
): { commands: SlashCommand[]; notes: string[] } {
  const notes: string[] = [];
  const commands: SlashCommand[] = [
    ...skillCommands(paths.skills, store),
    ...commandFiles(join(paths.root, 'commands'), 'md', ':', {
      source: 'command',
      owner: 'commands/',
    }),
    ...pluginCommands(join(paths.root, 'plugins'), paths.settings, notes),
  ];

  return { commands: sortCommands(commands), notes };
}

/**
 * Скиллы пользователя. Выключенный скилл (перенесён в `skills-disabled/`) из
 * палитры пропадает — и это ровно то, что человек хочет увидеть, поэтому он
 * остаётся в списке с пометкой, а не исчезает.
 */
function skillCommands(skillsDir: string, store: AppStore): SlashCommand[] {
  const disabledDir = join(dirname(skillsDir), SKILLS_DISABLED_DIR);

  return readSkills(skillsDir, store).map((skill) => ({
    id: `skill:${skill.id}`,
    invocation: `/${skill.id}`,
    name: skill.id,
    source: 'skill' as const,
    description: trim(skill.description),
    owner: 'skills/',
    path: join(skill.isEnabled ? skillsDir : disabledDir, skill.id),
    isEnabled: skill.isEnabled,
    aliases: [],
    related: [],
    target: 'skill' as const,
    targetId: skill.id,
  }));
}

/**
 * Команды и скиллы установленных плагинов.
 *
 * Реестр установленного (`plugins/installed_plugins.json`) говорит, где лежит
 * плагин, а `enabledPlugins` в settings.json — включён ли он. Выключенный
 * показываем помеченным: его команды из палитры пропали, и человеку важно
 * понять почему, а не гадать, куда делась команда.
 */
function pluginCommands(
  pluginsRoot: string,
  settingsPath: string,
  notes: string[],
): SlashCommand[] {
  const registry = readJson(join(pluginsRoot, 'installed_plugins.json'));
  const plugins = (registry as { plugins?: Record<string, unknown> })?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];

  const enabled = (readJson(settingsPath) as { enabledPlugins?: Record<string, boolean> })
    ?.enabledPlugins;
  const commands: SlashCommand[] = [];

  for (const [id, entries] of Object.entries(plugins)) {
    const installPath = firstInstallPath(entries);
    if (!installPath) continue;
    if (!existsSync(installPath)) {
      notes.push(`Плагин «${id}»: каталог установки не найден (${installPath}).`);
      continue;
    }

    const slug = id.split('@')[0] ?? id;
    const isEnabled = enabled?.[id] !== false;
    const owner = id;

    const own = [
      ...commandFiles(join(installPath, 'commands'), 'md', ':', {
        source: 'plugin',
        owner,
        prefix: slug,
      }),
      ...pluginSkills(join(installPath, 'skills'), slug, owner),
    ];

    commands.push(...own.map((command) => ({ ...command, isEnabled, targetId: id })));
  }

  return commands;
}

/** Скиллы плагина — те же папки со `SKILL.md`, вызов с префиксом плагина. */
function pluginSkills(skillsDir: string, slug: string, owner: string): SlashCommand[] {
  if (!isDirectory(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .slice(0, FILE_LIMIT)
    .map((entry) => {
      const file = join(skillsDir, entry.name, 'SKILL.md');
      const parsed = existsSync(file) ? readMdCommand(file) : { description: '' };
      const invocation = `/${slug}:${entry.name}`;

      return {
        id: `plugin:${invocation}`,
        invocation,
        name: entry.name,
        source: 'plugin' as const,
        description: parsed.description,
        owner,
        path: file,
        isEnabled: true,
        aliases: [],
        related: [],
        target: 'plugin' as const,
      };
    });
}

/** Реестр держит массив установок плагина; берём первую с путём. */
function firstInstallPath(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (const entry of entries) {
    const path = (entry as { installPath?: unknown })?.installPath;
    if (typeof path === 'string' && path) return path;
  }
  return undefined;
}
