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
    rootFor: (location, id) => {
      const segment = safeSegment(id);
      return segment ? join(location.paths.root, 'plugins', 'cache', segment) : undefined;
    },
    isDirectory: true,
    // Плагин ставится и обновляется через CLI: править его файлы у себя —
    // значит потерять правки при первом же обновлении.
    isWritable: false,
  },
  rule: { kind: 'rule', isDirectory: false, isWritable: false },
  mcp: { kind: 'mcp', isDirectory: false, isWritable: false },
};

export function layoutOf(kind: string): ResourceLayout | undefined {
  return RESOURCE_LAYOUTS[kind as ResourceKind];
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
