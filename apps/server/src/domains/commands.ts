import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ClaudePaths, CommandsResponse, SlashCommand } from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { splitSkillFile } from '../lib/opencode-skill.ts';
import { readSkills, SKILLS_DISABLED_DIR } from './skills.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * Слэш-команды активного провайдера, собранные С ДИСКА.
 *
 * Почему раздел вообще есть: в палитре по `/` лежит вперемешку то, что пришло из
 * четырёх разных мест, и по имени не понять, что команда делает и чьё это.
 * Здесь всё сведено в один список — с описанием, владельцем и путём.
 *
 * ЧТО СОБИРАЕТСЯ У CLAUDE (все четыре источника задокументированы):
 *  - скиллы пользователя (`skills/<имя>/SKILL.md`) — вызываются как `/имя`;
 *  - файлы команд (`commands/**` с `.md`), подкаталог даёт `/каталог:имя`;
 *  - команды и скиллы установленных плагинов — с префиксом плагина;
 *  - встроенные команды CLI СЮДА НЕ ВХОДЯТ: файла у них нет, наружу CLI свой
 *    список не отдаёт, поэтому их каталог ведёт клиент панели.
 *
 * У ДРУГИХ CLI берём ровно то, что описано в их документации (`commandsConfig` в
 * каталоге провайдеров): Gemini и Qwen — `commands/*.toml`, OpenCode —
 * `commands/*.md` плюс ключ `command` в конфиге. Формата в документации нет →
 * возможность `unsupported`, раздел скрыт: угадывать чужие пути нельзя.
 *
 * РАЗДЕЛ ТОЛЬКО ЧИТАЕТ. Ничего не создаёт и не правит: у скилла есть свой раздел,
 * у плагина свой, а файлы чужого CLI панель здесь не трогает вовсе.
 */

/** Описание длиннее этого в списке не нужно — карточка станет нечитаемой. */
const DESCRIPTION_LIMIT = 400;

/** Сколько файлов читаем максимум: защита от каталога, набитого мусором. */
const FILE_LIMIT = 500;

export function readCommands(paths: ClaudePaths, store: AppStore): CommandsResponse {
  const provider = getActiveProvider(store);

  if (provider.id === 'claude') {
    return { provider: provider.id, ...readClaudeCommands(paths, store) };
  }
  return { provider: provider.id, ...readProviderCommands(provider) };
}

/* ------------------------------- Claude ---------------------------------- */

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
 * Файлы команд каталога. Подкаталог — пространство имён: `git/commit.md`
 * вызывается как `/git:commit` (разделитель у каждого CLI свой, поэтому он
 * приходит аргументом).
 */
function commandFiles(
  dir: string,
  extension: 'md' | 'toml',
  separator: string | undefined,
  meta: { source: 'command' | 'plugin'; owner: string; prefix?: string },
): SlashCommand[] {
  const files = listFiles(dir, `.${extension}`, separator !== undefined);
  return files.map((file) => {
    const segments = file.relative.split('/');
    const name = segments
      .map((segment, index) =>
        index === segments.length - 1 ? basename(segment, `.${extension}`) : segment,
      )
      .join(separator ?? '');
    const parsed = extension === 'toml' ? readTomlCommand(file.path) : readMdCommand(file.path);
    const invocation = meta.prefix ? `/${meta.prefix}:${name}` : `/${name}`;

    return {
      id: `${meta.source}:${invocation}`,
      invocation,
      name,
      source: meta.source,
      description: parsed.description,
      owner: meta.owner,
      path: file.path,
      isEnabled: true,
      ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
      aliases: [],
      related: [],
      target: meta.source === 'plugin' ? ('plugin' as const) : ('none' as const),
    };
  });
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

/* ------------------------- Остальные провайдеры --------------------------- */

export function readProviderCommands(provider: ConfigProvider): {
  commands: SlashCommand[];
  notes: string[];
} {
  const config = provider.commandsConfig;
  if (!config) return { commands: [], notes: [] };

  const notes: string[] = [];
  const dir = config.dir();
  if (!isDirectory(dir)) notes.push(`Каталог команд не найден: ${dir}.`);

  const commands = commandFiles(
    dir,
    config.format === 'toml-prompt' ? 'toml' : 'md',
    config.namespaceSeparator,
    { source: 'command', owner: provider.name },
  );

  return {
    commands: sortCommands([...commands, ...configCommands(config.configPath?.(), provider.name)]),
    notes,
  };
}

/**
 * Команды, объявленные ключом в самом конфиге (OpenCode: `command`), — второй
 * задокументированный источник. Без него список показал бы половину правды.
 */
function configCommands(path: string | undefined, owner: string): SlashCommand[] {
  if (!path) return [];
  const config = readJson(path) as { command?: Record<string, unknown> } | undefined;
  const entries = config?.command;
  if (!entries || typeof entries !== 'object') return [];

  return Object.entries(entries).map(([name, value]) => {
    const entry = (value ?? {}) as { description?: unknown };

    return {
      id: `command:/${name}`,
      invocation: `/${name}`,
      name,
      source: 'command' as const,
      description: typeof entry.description === 'string' ? trim(entry.description) : '',
      owner,
      path,
      isEnabled: true,
      aliases: [],
      related: [],
      target: 'none' as const,
    };
  });
}

/* --------------------------------- Разбор -------------------------------- */

/**
 * Шапка `.md`-команды. Читаем ЛИНИЯМИ, а не полноценным YAML: нужны два
 * необязательных поля, а всё прочее в шапке — дело автора файла, и падать из-за
 * него список не должен.
 */
function readMdCommand(path: string): { description: string; argumentHint?: string } {
  const text = readText(path);
  if (text === undefined) return { description: '' };

  const parts = splitSkillFile(text);
  if (!parts) {
    // Шапки нет — за описание сходит первая непустая строка тела: это лучше,
    // чем пустая карточка, и это ровно то, что человек увидит в файле.
    return { description: firstMeaningfulLine(text) };
  }

  const header = readHeaderKeys(parts.frontmatter);
  const hint = header['argument-hint'];

  return {
    description: header.description ?? firstMeaningfulLine(parts.body),
    ...(hint ? { argumentHint: hint } : {}),
  };
}

/** Команда Gemini/Qwen: `.toml` с обязательным `prompt` и необязательным `description`. */
function readTomlCommand(path: string): { description: string; argumentHint?: string } {
  const text = readText(path);
  if (text === undefined) return { description: '' };

  try {
    const parsed = parseToml(text) as { description?: unknown; prompt?: unknown };
    if (typeof parsed.description === 'string') return { description: trim(parsed.description) };
    // Описание необязательно — тогда показываем начало самого промпта: он и есть
    // ответ на вопрос «что эта команда делает».
    if (typeof parsed.prompt === 'string')
      return { description: firstMeaningfulLine(parsed.prompt) };
  } catch {
    // Файл не разбирается — команда всё равно существует, покажем её без описания.
  }
  return { description: '' };
}

/** Простые `ключ: значение` шапки. Кавычки снимаем, вложенность игнорируем. */
function readHeaderKeys(frontmatter: string): Record<string, string> {
  const header: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const value = (match[2] ?? '').trim().replace(/^["'](.*)["']$/, '$1');
    if (value) header[match[1]] = trim(value);
  }

  return header;
}

function firstMeaningfulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0 && !item.startsWith('#') && !item.startsWith('---'));
  return line ? trim(line) : '';
}

/* ------------------------------- Файлы ----------------------------------- */

interface FoundFile {
  path: string;
  /** Путь относительно корня каталога, через `/` — из него строится имя. */
  relative: string;
}

function listFiles(dir: string, extension: string, recursive: boolean): FoundFile[] {
  if (!isDirectory(dir)) return [];

  const found: FoundFile[] = [];
  const walk = (current: string, prefix: string): void => {
    if (found.length >= FILE_LIMIT) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (found.length >= FILE_LIMIT) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(path, `${prefix}${entry.name}/`);
        continue;
      }
      if (extname(entry.name).toLowerCase() === extension) {
        found.push({ path, relative: `${prefix}${entry.name}` });
      }
    }
  };

  walk(dir, '');
  return found;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(path: string): unknown {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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

function trim(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > DESCRIPTION_LIMIT ? `${single.slice(0, DESCRIPTION_LIMIT)}…` : single;
}

/** Порядок — по вызову: список читают глазами, и алфавит здесь единственный понятный. */
function sortCommands(commands: SlashCommand[]): SlashCommand[] {
  return [...commands].sort((a, b) => a.invocation.localeCompare(b.invocation));
}
