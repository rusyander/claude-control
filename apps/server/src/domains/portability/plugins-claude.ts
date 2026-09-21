import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EnvItem, EnvItemKind, EnvSkip } from '@agentdeck/contracts/portable-env';
import type { ConfigProvider } from '../../providers/types.ts';
import { readJsonFile, readTextFile } from '../../lib/safe-io.ts';
import { splitFrontmatter } from '../skills/frontmatter.ts';
import { envItemId, envSkip } from './canon.ts';
import { commandItem, pluginItem, skillItem, subagentItem } from './normalize-files.ts';
import { normalizeHooks, scriptPathOf, type HookInput } from './normalize-hooks.ts';
import { sourceFactory } from './normalize-types.ts';
import { readSubagentsDir } from './subagents.ts';
import type { ImportResult, ObservedNeeds } from './types.ts';

/**
 * Плагины Claude → канон: СОДЕРЖИМЫМ, а не как плагины (П2.6).
 *
 * Плагин — это набор скиллов, команд, субагентов и хуков, лежащий в своём
 * каталоге. Ни один чужой CLI плагинов Claude не ставит, поэтому переносить
 * «плагин» как единицу почти всегда некуда, а вот его записи переносятся
 * обычным порядком — и поэтому раскладываются здесь на записи канона с пометкой
 * происхождения (`source.plugin`). Без пометки скилл плагина был бы неотличим
 * от собственного: человек не узнал бы, что перенёс чужой набор, а повторная
 * установка плагина у цели дала бы второй экземпляр того же скилла.
 *
 * Реестр читается С ДИСКА (`plugins/installed_plugins.json`), а не командой
 * `claude plugin list`: паспорт среды чужих процессов не запускает. Прежде
 * раздел целиком назывался непрочитанным по этой же причине — файл реестра
 * просто не был прочитан ни разу.
 *
 * ВЫКЛЮЧЕННЫЙ ПЛАГИН НЕ РАСКЛАДЫВАЕТСЯ. Его записи у источника не действуют, а
 * у команды и субагента состояния вкл/выкл в каноне нет вовсе — приехав к цели,
 * они бы работали. Поэтому едет сам плагин выключенной записью, а его
 * содержимое названо пропуском с причиной: «не перенесено, потому что выключено»
 * честнее, чем «перенесено включённым».
 */

/** Файл реестра: единственная раскладка, которую CLI ведёт сам. */
const REGISTRY_FILE = 'installed_plugins.json';

/** Подкаталоги плагина, каждый со своим видом записи. */
const CONTENT_DIRS = {
  skills: 'skill',
  commands: 'command',
  agents: 'subagent',
  hooks: 'hook',
} as const satisfies Record<string, EnvItemKind>;

interface RegistryInstall {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

interface Registry {
  version?: unknown;
  plugins?: Record<string, RegistryInstall[] | undefined>;
}

/**
 * Версия реестра, которую читает сам Claude Code. Число то же и по той же
 * причине, что у раздела команд (`domains/commands/claude.ts`): реестр другой
 * версии CLI не загружает вовсе, и плагины из него у человека НЕ ДЕЙСТВУЮТ.
 * Разложить их на записи значило бы обещать перенос того, что и у источника
 * молчит, — а у цели эти записи заработали бы (инвариант 3, fail-closed).
 */
const REGISTRY_VERSION = 2;

/** Ключ состояния плагинов в файле настроек: `<плагин>@<магазин>` → включён. */
interface SettingsWithPlugins {
  enabledPlugins?: Record<string, unknown>;
}

export interface ClaudePluginsDeps {
  /** `<корень>/plugins`. */
  pluginsDir: string;
  /** Файлы настроек по возрастанию старшинства: общий, затем локальный. */
  settingsPaths: readonly string[];
  provider: ConfigProvider;
  scope: 'global' | 'project';
  observedNeeds?: ObservedNeeds;
}

/** Плагины дома Claude — записями канона плюс названными пропусками. */
export function readClaudePlugins(deps: ClaudePluginsDeps): ImportResult {
  const registryPath = join(deps.pluginsDir, REGISTRY_FILE);
  if (!existsSync(registryPath)) {
    return {
      items: [],
      skipped: [envSkip('plugin', 'empty', `${registryPath}: реестр плагинов не заведён`)],
    };
  }

  const registry = readJsonFile<Registry>(registryPath, {});
  if (registry.version !== REGISTRY_VERSION) {
    // Реестр чужой версии CLI не читает — плагинов из него у человека нет ни
    // одного. Пропуск называет версию: «плагинов не нашлось» скрыло бы, что
    // файл-то есть, просто он другой.
    return {
      items: [],
      skipped: [
        envSkip(
          'plugin',
          'unsupported_format',
          `${registryPath}: реестр версии ${String(registry.version ?? 'без номера')}, ` +
            `Claude Code читает только версию ${REGISTRY_VERSION} — эти плагины не действуют`,
        ),
      ],
    };
  }
  const installed = registry.plugins ?? {};
  const enabledMap = readEnabledPlugins(deps.settingsPaths);

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const id of Object.keys(installed).sort()) {
    const install = pickInstall(installed[id] ?? []);
    if (!install) {
      skipped.push(envSkip('plugin', 'not_readable', `${id}: в реестре нет пути установки`));
      continue;
    }
    if (!isDirectory(install.path)) {
      // Каталог вычищен «подметанием» CLI, а запись реестра осталась: плагина
      // на диске нет, и переносить из него нечего.
      skipped.push(
        envSkip('plugin', 'not_readable', `${id}: каталога ${install.path} нет на диске`),
      );
      continue;
    }

    const provides = providedKinds(install.path);
    // Состояние по умолчанию — ВЫКЛЮЧЕН: ключа в настройках нет ровно у того
    // плагина, которого человек не включал, и считать его действующим значило бы
    // увезти к цели записи, которые у источника молчат.
    const enabled = enabledMap.get(id) === true;
    const source = sourceFactory(deps.provider.id, deps.scope, install.manifest, id);

    items.push({
      ...pluginItem({
        source,
        name: id,
        version: install.version,
        // Единица магазина Claude: у цели её не поставить ничем, поэтому едет
        // только СОДЕРЖИМОЕ — записи ниже.
        form: 'installed',
        readOnly: false,
        provides,
        file: install.manifest,
        raw: JSON.stringify({ id, installPath: install.path, version: install.version }),
      }),
      enabled,
    });

    if (!enabled) {
      for (const kind of provides) {
        skipped.push(
          envSkip(kind, 'disabled', `${id}: плагин выключен, его записи не действуют и не едут`),
        );
      }
      continue;
    }

    const content = readPluginContent({ deps, id, root: install.path, source });
    items.push(...content.items);
    skipped.push(...content.skipped);
  }

  return { items, skipped };
}

/** Установка плагина, выбранная для чтения. */
interface PickedInstall {
  path: string;
  version: string | null;
  manifest: string;
}

/**
 * Какую из установок читать. Реестр держит массив: один и тот же плагин может
 * стоять и домом, и проектом. Берётся домашняя (`scope: 'user'`) — паспорт дома
 * описывает дом; её нет — первая, у которой есть путь.
 */
function pickInstall(installs: readonly RegistryInstall[]): PickedInstall | undefined {
  const withPath = installs.filter((entry) => typeof entry.installPath === 'string');
  const chosen = withPath.find((entry) => entry.scope === 'user') ?? withPath[0];
  if (!chosen) return undefined;
  const path = chosen.installPath as string;
  return {
    path,
    version: typeof chosen.version === 'string' ? chosen.version : null,
    manifest: join(path, '.claude-plugin', 'plugin.json'),
  };
}

/**
 * Состояние плагинов из файлов настроек. Локальный файл старше общего — тем же
 * порядком, каким их читают все остальные разделы панели.
 */
function readEnabledPlugins(settingsPaths: readonly string[]): Map<string, boolean> {
  const state = new Map<string, boolean>();
  for (const path of settingsPaths) {
    const settings = readJsonFile<SettingsWithPlugins>(path, {});
    for (const [id, value] of Object.entries(settings.enabledPlugins ?? {})) {
      if (typeof value === 'boolean') state.set(id, value);
    }
  }
  return state;
}

/** Какие виды записей плагин приносит: по его подкаталогам, а не по манифесту. */
function providedKinds(root: string): EnvItemKind[] {
  const kinds: EnvItemKind[] = [];
  for (const [dir, kind] of Object.entries(CONTENT_DIRS)) {
    if (isDirectory(join(root, dir))) kinds.push(kind);
  }
  return kinds;
}

interface ContentDeps {
  deps: ClaudePluginsDeps;
  id: string;
  root: string;
  source: ReturnType<typeof sourceFactory>;
}

/** Содержимое одного плагина: скиллы, команды, субагенты, хуки. */
function readPluginContent(params: ContentDeps): ImportResult {
  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const part of [pluginSkills, pluginCommands, pluginSubagents, pluginHooks]) {
    const result = part(params);
    items.push(...result.items);
    skipped.push(...result.skipped);
  }

  return { items, skipped };
}

/**
 * Идентичность записи, принесённой плагином. Плагин входит в ключ, и это не
 * украшение: свой скилл `code-review` и скилл `code-review` из плагина — две
 * разные записи одного дома, а по идентификатору идёт идемпотентный upsert
 * (инвариант 10). С общим ключом одна молча затёрла бы другую у цели, а
 * повторный перенос того же плагина создал бы её заново.
 */
function pluginIdentity<T extends EnvItem>(item: T, pluginId: string, name: string): T {
  return { ...item, id: envItemId(item.kind, `plugin/${pluginId}/${name}`) };
}

function pluginSkills(params: ContentDeps): ImportResult {
  const dir = join(params.root, 'skills');
  if (!isDirectory(dir)) return { items: [], skipped: [] };

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];
  for (const name of listDir(dir)) {
    const skillFile = join(dir, name, 'SKILL.md');
    if (!existsSync(skillFile)) {
      skipped.push(envSkip('skill', 'unsupported_format', `${name}: в каталоге нет SKILL.md`));
      continue;
    }
    const raw = readTextFile(skillFile);
    const { frontmatter, body } = splitFrontmatter(raw);
    items.push(
      pluginIdentity(
        skillItem({
          source: params.source,
          name,
          description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
          body,
          dir: join(dir, name),
          enabled: true,
          raw,
        }),
        params.id,
        name,
      ),
    );
  }
  return { items, skipped };
}

function pluginCommands(params: ContentDeps): ImportResult {
  const dir = join(params.root, 'commands');
  if (!isDirectory(dir)) return { items: [], skipped: [] };

  const items: EnvItem[] = [];
  const walk = (current: string, namespace: string | null): void => {
    for (const name of listDir(current)) {
      const full = join(current, name);
      if (isDirectory(full)) {
        walk(full, namespace ? `${namespace}:${name}` : name);
        continue;
      }
      if (!name.toLowerCase().endsWith('.md')) continue;
      const raw = readTextFile(full);
      const { frontmatter, body } = splitFrontmatter(raw);
      const commandName = name.slice(0, -3);
      items.push(
        pluginIdentity(
          commandItem({
            source: params.source,
            name: commandName,
            namespace,
            description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
            prompt: body.trim(),
            file: full,
            raw,
          }),
          params.id,
          namespace ? `${namespace}-${commandName}` : commandName,
        ),
      );
    }
  };
  walk(dir, null);
  return { items, skipped: [] };
}

function pluginSubagents(params: ContentDeps): ImportResult {
  const dir = join(params.root, 'agents');
  if (!isDirectory(dir)) return { items: [], skipped: [] };

  const scan = readSubagentsDir(dir);
  return {
    items: scan.subagents.map((parsed) =>
      pluginIdentity(subagentItem(params.source, parsed), params.id, parsed.name),
    ),
    skipped: scan.problems.map((problem) =>
      envSkip('subagent', 'unsupported_format', `${problem.filePath}: ${problem.detail}`),
    ),
  };
}

/** Хуки плагина в форме файла настроек Claude: событие → правила → команды. */
interface PluginHooksFile {
  hooks?: Record<
    string,
    { matcher?: unknown; hooks?: { type?: unknown; command?: unknown; timeout?: unknown }[] }[]
  >;
}

/**
 * Переменная, которой плагин зовёт СВОЙ каталог. У цели её никто не
 * подставляет: в чужой конфиг обязан уехать абсолютный путь, иначе хук
 * зарегистрирован, а исполнять нечего (критерий П2.6).
 */
const PLUGIN_ROOT_VARIABLE = /\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g;

function pluginHooks(params: ContentDeps): ImportResult {
  const file = join(params.root, 'hooks', 'hooks.json');
  if (!existsSync(file)) return { items: [], skipped: [] };

  const parsed = readJsonFile<PluginHooksFile>(file, {});
  const inputs: HookInput[] = [];
  for (const [event, rules] of Object.entries(parsed.hooks ?? {})) {
    for (const rule of rules ?? []) {
      for (const hook of rule.hooks ?? []) {
        if (typeof hook.command !== 'string') continue;
        // Подстановка идёт в написании с `/` — и это не косметика. Команда
        // плагина написана через `/`, и смешанное написание давало путь вида
        // `C:\дом\плагин/hooks/guard.mjs`: обратная косая в строке команды —
        // экранирование для всякой оболочки семейства sh, а распознаватель пути
        // скрипта требует `/` и такой путь просто не увидел бы.
        const command = hook.command.replace(PLUGIN_ROOT_VARIABLE, pluginRootPath(params.root));
        inputs.push({
          event,
          matcher: typeof rule.matcher === 'string' ? rule.matcher : null,
          command,
          timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
          scriptPath: scriptPathOf(command),
          enabled: true,
          raw: JSON.stringify(hook),
        });
      }
    }
  }

  const normalized = normalizeHooks(inputs, {
    source: params.source,
    provider: params.deps.provider,
    timeoutUnit: 's',
    observedNeeds: params.deps.observedNeeds,
    ownMachine: true,
  });

  return {
    items: normalized.items.map((item) =>
      pluginIdentity(item, params.id, `${item.trigger.on}-${item.command}`),
    ),
    skipped: normalized.skipped,
  };
}

/** Каталог плагина в написании команды: разделитель `/` на любой ОС. */
function pluginRootPath(root: string): string {
  return root.split('\\').join('/');
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
