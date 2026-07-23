import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import type {
  CommandResult,
  Marketplace,
  Plugin,
  PluginsState,
  PluginScaffoldRequest,
  PluginScaffoldResult,
} from '@claude-control/contracts';
import { safePluginId } from '../lib/cli-args.ts';
import { writeTextFile } from '../lib/safe-io.ts';

const execFileAsync = promisify(execFile);

/**
 * Работа с плагинами через штатный CLI Claude Code. Установка плагина —
 * это клонирование репозитория маркетплейса и обновление нескольких файлов
 * состояния; воспроизводить это своими руками нельзя, иначе состояние
 * разъедется с тем, что видит сам Claude Code.
 */

/** На Windows claude — это .cmd-обёртка, её нельзя запустить без shell. */
const isWindows = process.platform === 'win32';

async function runClaude(
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  const command = isWindows ? 'claude.cmd' : 'claude';
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    shell: isWindows,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * CLI отдаёт установленные и доступные плагины в разной форме: `plugin list
 * --json` — массив с полем id, а `--available` — объект `{installed, available}`,
 * где у записей каталога поля названы иначе (pluginId, marketplaceName).
 * Поэтому здесь оба набора имён.
 */
interface RawPlugin {
  id?: string;
  pluginId?: string;
  name?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  description?: string;
  marketplaceName?: string;
  /** Сколько раз плагин установили — по нему сортируется каталог. */
  installCount?: number;
}

function toPlugin(raw: RawPlugin, isInstalled: boolean): Plugin {
  const id = raw.pluginId ?? raw.id ?? '';
  const [idName = id, idMarketplace = ''] = id.split('@');

  return {
    id,
    name: raw.name ?? idName,
    marketplace: raw.marketplaceName ?? idMarketplace,
    version: raw.version ?? 'unknown',
    scope: raw.scope ?? 'user',
    isEnabled: raw.enabled ?? false,
    installPath: raw.installPath,
    installedAt: raw.installedAt,
    lastUpdated: raw.lastUpdated,
    isInstalled,
    description: raw.description,
    installCount: raw.installCount,
  };
}

/**
 * Быстрый путь: только установленные плагины и маркетплейсы. Каталог доступных
 * запрашивается отдельно, потому что CLI за ним ходит в сеть и обновляет
 * репозитории маркетплейсов — держать из-за этого весь раздел в загрузке нельзя.
 */
export async function readPlugins(claudeRoot: string): Promise<PluginsState> {
  const installed = await readInstalled();
  return { installed, available: [], marketplaces: readMarketplaces(claudeRoot) };
}

/** Каталог маркетплейсов: отдельный запрос, выполняется по требованию. */
export async function readAvailablePlugins(): Promise<Plugin[]> {
  return readAvailable(await readInstalled());
}

async function readInstalled(): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(['plugin', 'list', '--json'], 60_000);
    return parseList(stdout, 'installed').map((item) => toPlugin(item, true));
  } catch {
    // CLI недоступен или сменил формат — раздел покажет пустой список,
    // но приложение не должно из-за этого падать целиком.
    return [];
  }
}

async function readAvailable(installed: Plugin[]): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(['plugin', 'list', '--available', '--json'], 180_000);
    const installedIds = new Set(installed.map((plugin) => plugin.id));

    return parseList(stdout, 'available')
      .map((item) => toPlugin(item, false))
      .filter((plugin) => plugin.id && !installedIds.has(plugin.id))
      .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
  } catch {
    return [];
  }
}

/**
 * Разбор вывода CLI. Перед JSON бывают предупреждения, а сама структура —
 * либо массив, либо объект с ключами installed/available, поэтому нужный
 * список достаём по имени.
 */
function parseList(stdout: string, key: 'installed' | 'available'): RawPlugin[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];

  const end = Math.max(stdout.lastIndexOf(']'), stdout.lastIndexOf('}'));
  if (end <= start) return [];

  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (Array.isArray(parsed)) return parsed as RawPlugin[];

  const list = (parsed as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as RawPlugin[]) : [];
}

function readMarketplaces(claudeRoot: string): Marketplace[] {
  const file = join(claudeRoot, 'plugins', 'known_marketplaces.json');
  if (!existsSync(file)) return [];

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      {
        source?: { source?: string; repo?: string };
        installLocation?: string;
        lastUpdated?: string;
      }
    >;

    return Object.entries(parsed).map(([name, value]) => ({
      name,
      source: value.source?.repo ?? value.source?.source ?? '',
      installLocation: value.installLocation,
      lastUpdated: value.lastUpdated,
    }));
  } catch {
    return [];
  }
}

async function runPluginCommand(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await runClaude(['plugin', ...args]);
    return { ok: true, output: (stdout || stderr).trim(), needsRestart: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = (error as { stdout?: string; stderr?: string }).stderr ?? detail;
    return { ok: false, output: output.trim(), needsRestart: false };
  }
}

/**
 * Источник маркетплейса — репозиторий, URL или путь. Значение уходит в команду,
 * а на Windows команда идёт через оболочку, поэтому метасимволы и пробел сюда не
 * пускаем: разрешены только буквы, цифры и безопасные знаки адреса/пути.
 */
const MARKETPLACE_SOURCE = /^[A-Za-z0-9._~:/@\\-]{1,300}$/;

/** Добавить маркетплейс: `claude plugin marketplace add <источник>`. */
export function addMarketplace(source: string): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(source)) {
    return Promise.resolve({
      ok: false,
      output: `Недопустимый источник: ${source}`,
      needsRestart: false,
    });
  }
  return runPluginCommand(['marketplace', 'add', source]);
}

/** Убрать маркетплейс по имени: `claude plugin marketplace remove <имя>`. */
export function removeMarketplace(name: string): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(name)) {
    return Promise.resolve({ ok: false, output: `Недопустимое имя: ${name}`, needsRestart: false });
  }
  return runPluginCommand(['marketplace', 'remove', name]);
}

/**
 * Идентификатор приходит из запроса, а на Windows команда уходит в оболочку —
 * поэтому он сверяется с допустимым видом до запуска. Отказ возвращается
 * обычным ответом: страница плагинов покажет его как результат операции.
 */
function runPluginAction(action: string, id: string): Promise<CommandResult> {
  let checked: string;
  try {
    checked = safePluginId(id);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      needsRestart: false,
    });
  }

  return runPluginCommand([action, checked]);
}

export const installPlugin = (id: string): Promise<CommandResult> => runPluginAction('install', id);

export const uninstallPlugin = (id: string): Promise<CommandResult> =>
  runPluginAction('uninstall', id);

export const enablePlugin = (id: string): Promise<CommandResult> => runPluginAction('enable', id);

export const disablePlugin = (id: string): Promise<CommandResult> => runPluginAction('disable', id);

export const updatePlugin = (id: string): Promise<CommandResult> => runPluginAction('update', id);

/**
 * Имя плагина → безопасное имя папки и поле `name` манифеста.
 *
 * Формат Claude Code: строчные буквы, цифры и дефис. Пробелы и разделители
 * схлопываются в дефис, остальное отбрасывается. Пусто на выходе — имя из
 * одних недопустимых символов, создавать по нему нечего.
 */
export function pluginSlug(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

const MANIFEST_DIR = '.claude-plugin';

/** Пример команды: фронтматтер по формату Claude Code + тело-подсказка. */
function commandTemplate(slug: string): string {
  return `---
description: Пример команды плагина ${slug}
argument-hint: [аргумент]
allowed-tools: Read
---

Опишите здесь, что должна сделать команда. Доступны:
- аргументы: $1, $2 или $ARGUMENTS
- файлы: @путь/к/файлу
- вывод команды: !\`команда\`
`;
}

/** Пример субагента: минимальный фронтматтер name + description. */
function agentTemplate(slug: string): string {
  return `---
name: ${slug}-helper
description: Пример субагента плагина ${slug}. Опишите, когда его вызывать.
---

Системная инструкция субагента. Опишите его роль, границы и формат ответа.
`;
}

/** Пример скилла: фронтматтер SKILL.md с name и description. */
function skillTemplate(slug: string): string {
  return `---
name: ${slug}
description: Пример скилла плагина ${slug}. Опишите, при каких запросах он применяется.
---

# ${slug}

Тело скилла: шаги, правила и примеры. Файлы рядом (references/, scripts/)
подхватываются автоматически.
`;
}

/** Пример hooks.json: один PreToolUse-хук с командой через CLAUDE_PLUGIN_ROOT. */
function hooksTemplate(): string {
  return `${JSON.stringify(
    {
      description: 'Пример хуков плагина',
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              {
                type: 'command',
                command: '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/example.sh',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

function readmeTemplate(slug: string, description: string): string {
  return `# ${slug}

${description || 'Плагин Claude Code.'}

## Структура

- \`.claude-plugin/plugin.json\` — манифест плагина
- \`commands/\` — слэш-команды (Markdown с фронтматтером)
- \`agents/\` — субагенты
- \`skills/\` — скиллы (папка с \`SKILL.md\`)
- \`hooks/hooks.json\` — хуки на события

## Установка для разработки

Добавьте маркетплейс из папки-родителя и установите плагин через
\`claude plugin\`.
`;
}

/**
 * Каркас плагина в выбранной папке.
 *
 * Плагин создаётся подпапкой `<имя>` внутри выбранного каталога: так чужие
 * файлы каталога не смешиваются с плагином, а повторный запуск не затирает
 * готовый плагин без явного `force`. Формат манифеста и структуры — по докам
 * Claude Code (`.claude-plugin/plugin.json`, авто-обнаружение commands/, agents/,
 * skills/, hooks/hooks.json).
 */
export function scaffoldPlugin(request: PluginScaffoldRequest): PluginScaffoldResult {
  const fail = (error: string): PluginScaffoldResult => ({
    ok: false,
    path: '',
    created: [],
    error,
  });

  const slug = pluginSlug(request.name);
  if (!slug) return fail('Недопустимое имя плагина: оставьте буквы, цифры и дефис');

  // Каталог приходит из выбора пользователя (FolderPicker) — он и есть граница
  // доверия. Но требуем абсолютный существующий путь: относительный склеился бы
  // с рабочим каталогом сервера, а несуществующий — молча создал бы дерево не там.
  const dir = request.dir?.trim();
  if (!dir || !isAbsolute(dir)) return fail('Каталог должен быть абсолютным путём');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return fail('Выбранный каталог не найден');
  }

  const base = resolve(dir);
  const target = resolve(base, slug);
  // Имя уже очищено до [a-z0-9-], выйти из каталога им нельзя; проверка —
  // страховка на случай изменения правил слага.
  if (target !== join(base, slug) || !target.startsWith(`${base}${sep}`)) {
    return fail('Недопустимое имя плагина');
  }

  if (existsSync(target) && !request.force) {
    return fail('Плагин с таким именем уже существует в этой папке');
  }

  const author = request.author?.trim();
  const manifest = {
    name: slug,
    version: '0.1.0',
    description: request.description?.trim() || '',
    ...(author ? { author: { name: author } } : {}),
    license: 'MIT',
    keywords: [] as string[],
  };

  const files: Array<{ path: string; content: string }> = [
    { path: `${MANIFEST_DIR}/plugin.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'README.md', content: readmeTemplate(slug, manifest.description) },
  ];

  if (request.components.commands) {
    files.push({ path: 'commands/example.md', content: commandTemplate(slug) });
  }
  if (request.components.agents) {
    files.push({ path: 'agents/example.md', content: agentTemplate(slug) });
  }
  if (request.components.skills) {
    files.push({ path: `skills/${slug}/SKILL.md`, content: skillTemplate(slug) });
  }
  if (request.components.hooks) {
    files.push({ path: 'hooks/hooks.json', content: hooksTemplate() });
  }

  const created: string[] = [];
  for (const file of files) {
    // writeTextFile сам создаёт недостающие папки и пишет атомарно.
    writeTextFile(join(target, ...file.path.split('/')), file.content);
    created.push(file.path);
  }

  return { ok: true, path: target, created };
}
