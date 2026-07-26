import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ClaudeLocation } from '@claude-control/contracts';

/**
 * Реестр видов ресурсов.
 *
 * Скиллы, скрипты, хуки и остальное хранятся по-разному: скилл — это папка,
 * скрипт — файл в hooks/, а хук с MCP-сервером живут записями в JSON. Но
 * работа с ними одинаковая: посмотреть, поправить, добавить, удалить.
 *
 * Поэтому вместо шести почти одинаковых наборов маршрутов заведён один,
 * а различия вынесены сюда — в описание вида. Новый вид добавляется записью
 * в реестр, а не копией кода.
 */

export type ResourceKind = 'skill' | 'script' | 'hook' | 'rule' | 'mcp' | 'plugin';

export interface ResourceLayout {
  kind: ResourceKind;
  /**
   * Где лежат файлы ресурса. `undefined` означает, что файлов на диске нет
   * (правило живёт строкой в CLAUDE.md) либо идентификатор небезопасен и
   * склеился бы с корнем каталога — тогда операцию нужно отклонить целиком.
   */
  rootFor?: (location: ClaudeLocation, id: string) => string | undefined;
  /**
   * Папка ли это. У скилла — папка целиком, у скрипта — один файл рядом
   * с другими, и удалять или обходить его нужно иначе.
   */
  isDirectory: boolean;
  /** Можно ли менять состав файлов: у плагинов файлы чужие, только чтение. */
  isWritable: boolean;
  /** Файл, который открывается первым. */
  entryFile?: string;
  /**
   * Папки, которые не показываем в дереве. У плагинов это служебные каталоги
   * кэша (`.in_use` с pid-локами, `.git` клона) — не файлы плагина, а шум.
   */
  ignoreDirs?: string[];
}

export const RESOURCE_LAYOUTS: Record<ResourceKind, ResourceLayout> = {
  skill: {
    kind: 'skill',
    rootFor: (location, id) => resourceRoot(location.paths.skills, id),
    isDirectory: true,
    isWritable: true,
    entryFile: 'SKILL.md',
  },
  script: {
    kind: 'script',
    // Скрипт — одиночный файл, но обходится тем же кодом: корнем считается
    // папка hooks/, а сам скрипт — файлом внутри неё.
    rootFor: (location) => location.paths.hooks,
    isDirectory: false,
    isWritable: true,
  },
  hook: {
    kind: 'hook',
    rootFor: (location) => location.paths.hooks,
    isDirectory: false,
    isWritable: true,
  },
  plugin: {
    kind: 'plugin',
    rootFor: (location, id) => resolvePluginRoot(location.paths.root, id),
    isDirectory: true,
    // Плагин ставится и обновляется через CLI: править его файлы у себя —
    // значит потерять правки при первом же обновлении.
    isWritable: false,
    entryFile: '.claude-plugin/plugin.json',
    ignoreDirs: ['.in_use', '.git', 'node_modules'],
  },
  rule: { kind: 'rule', isDirectory: false, isWritable: false },
  mcp: { kind: 'mcp', isDirectory: false, isWritable: false },
};

export function layoutOf(kind: string): ResourceLayout | undefined {
  return RESOURCE_LAYOUTS[kind as ResourceKind];
}

/**
 * Каталог установленного плагина на диске.
 *
 * CLI распаковывает плагин в `plugins/cache/<маркетплейс>/<имя>/<версия>`, а
 * идентификатор приходит как `<имя>@<маркетплейс>` — без версии. Поэтому имя и
 * маркетплейс берём из id, а версию читаем с диска: это единственный подкаталог,
 * который CLI туда положил. Так путь не приходится угадывать и он совпадает с
 * тем, что показывает `claude plugin list`.
 */
function resolvePluginRoot(claudeRoot: string, id: string): string | undefined {
  const at = id.indexOf('@');
  if (at <= 0) return undefined;

  // Каждый сегмент кладётся отдельно и с проверкой попадания внутрь предыдущего:
  // так ни имя, ни маркетплейс не могут увести путь за пределы кэша плагинов.
  const marketplaceDir = resourceRoot(join(claudeRoot, 'plugins', 'cache'), id.slice(at + 1));
  const base = marketplaceDir ? resourceRoot(marketplaceDir, id.slice(0, at)) : undefined;
  if (!base) return undefined;

  let versions: string[];
  try {
    versions = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      // Отметки версий сортируемы лексикографически; при нескольких берём
      // последнюю — CLI держит установленной именно её.
      .sort();
  } catch {
    // Плагина нет на диске (не установлен) — просмотр вернёт пустое дерево.
    return undefined;
  }

  const version = versions.at(-1);
  return version ? join(base, version) : undefined;
}

/**
 * Символы, из-за которых имя перестаёт быть ОДНИМ безопасным сегментом пути:
 * разделители каталогов и запрещённые в именах файлов Windows. Двоеточие
 * особенно важно — `SKILL.md:поток` на NTFS не имя файла, а альтернативный
 * поток внутри чужого.
 */
const UNSAFE_SEGMENT = /[\\/:*?"<>|]/;

/** Управляющий символ в имени — не опечатка, а попытка обмануть разбор пути. */
function hasControlChar(value: string): boolean {
  for (const char of value) {
    if ((char.codePointAt(0) ?? 0) < 0x20) return true;
  }
  return false;
}

/**
 * Идентификатор приходит из запроса и становится ОДНИМ сегментом пути.
 *
 * Раньше отсюда вырезалось всё, кроме `[a-zA-Z0-9._@-]`, — и это чинило ввод
 * вместо того, чтобы его проверять. Идентификатор скилла — это имя его папки,
 * а имена папкам даёт пользователь, поэтому кириллица здесь норма, а не атака:
 * `мой-skill` превращался в `-skill`, панель показывала пустое дерево
 * несуществующего скилла, а запись создавала папку-призрак рядом с настоящей.
 * Хуже того, чистка СКЛЕИВАЕТ разные имена в одно (`мой-skill` и `твой-skill`
 * дают тот же `-skill`) — правки уезжали в чужой ресурс.
 *
 * Поэтому имя больше не правится, а отвергается целиком, если перестаёт быть
 * одним сегментом внутри корня. Некрасивое имя папки (эмодзи, пробелы) — не
 * наша беда; выход за корень и совпадение двух разных имён — наша.
 */
export function safeSegment(value: string): string | undefined {
  if (!value || UNSAFE_SEGMENT.test(value) || hasControlChar(value)) return undefined;

  // `.` и `..` — не имена, а шаги вверх по дереву.
  if (/^\.+$/.test(value)) return undefined;

  // Windows молча срезает хвостовые точки и пробелы: `demo.` открыл бы `demo`,
  // то есть чужой ресурс под другим именем.
  if (process.platform === 'win32' && /[. ]$/.test(value)) return undefined;

  return value;
}

/**
 * Корень ресурса внутри базовой папки — второй рубеж после `safeSegment`.
 * Проверяем не только исходное имя, но и РЕЗУЛЬТАТ: что бы ни пропустила
 * проверка имени на конкретной системе, наружу базовой папки путь не уйдёт, а
 * совпадение с самим корнем (операция над всей папкой скиллов) отвергается.
 */
export function resourceRoot(base: string, id: string): string | undefined {
  const segment = safeSegment(id);
  if (!segment) return undefined;

  const root = resolve(base, segment);
  return root.startsWith(`${resolve(base)}${sep}`) ? root : undefined;
}
