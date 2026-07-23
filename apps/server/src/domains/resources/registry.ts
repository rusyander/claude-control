import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    rootFor: (location, id) => {
      const segment = safeSegment(id);
      return segment ? join(location.paths.skills, segment) : undefined;
    },
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

  const name = safeSegment(id.slice(0, at));
  const marketplace = safeSegment(id.slice(at + 1));
  if (!name || !marketplace) return undefined;

  const base = join(claudeRoot, 'plugins', 'cache', marketplace, name);

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
 * Идентификатор приходит из запроса и становится частью пути.
 *
 * Возвращает undefined, если после очистки не осталось безопасного имени:
 * кириллица и эмодзи вырезаются целиком, и пустой результат склеился бы с
 * корнем каталога — тогда операция ушла бы не на конкретный ресурс, а на всю
 * папку скиллов. Точки тоже отвергаем: `.` и `..` уводят вверх по дереву.
 */
export function safeSegment(value: string): string | undefined {
  const cleaned = value.replace(/[^a-zA-Z0-9._@-]/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..' || /^\.+$/.test(cleaned)) return undefined;
  return cleaned;
}
