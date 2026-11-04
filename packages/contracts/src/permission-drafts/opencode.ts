import type { OpencodePermissionDraft, OpencodePermissionEntry } from '../provider-permissions.ts';
import {
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  type OpencodePermissionLevel,
  type OpencodePermissionTool,
} from '../vocabulary.ts';

/**
 * Инструменты, у которых КАРТА ШАБЛОНОВ (шаблон → уровень) работает и панель
 * умеет её править: `bash` — команды (задокументировано), `read` — пути файлов
 * (снято живой пробой 09.10.2026, OpenCode 1.18.35).
 */
export const OPENCODE_PATTERN_TOOLS = ['bash', 'read'] as const;

/** Умеет ли панель править карту шаблонов у этого инструмента. */
export function supportsPatternMap(tool: string): boolean {
  return (OPENCODE_PATTERN_TOOLS as readonly string[]).includes(tool);
}

/** Уровень прав OpenCode из тела запроса: строка строго из набора. */
export function isOpencodeLevel(value: unknown): value is OpencodePermissionLevel {
  return (
    typeof value === 'string' && (OPENCODE_PERMISSION_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Разобрать черновик прав OpenCode: список ЗАДАННЫХ ограничений. Отклоняем
 * целиком (маршрут 400), если: не массив, незнакомый инструмент, повтор
 * инструмента, уровень вне набора, карта шаблонов у инструмента, для которого она
 * не задокументирована, пустая карта, пустой шаблон. Повторные шаблоны внутри
 * одной карты схлопываются (остаётся первое вхождение — в JSON-объекте
 * одноимённых ключей всё равно быть не может).
 */
export function parseOpencodeDraft(
  rec: Record<string, unknown>,
): OpencodePermissionDraft | undefined {
  const raw = rec.entries;
  if (!Array.isArray(raw)) return undefined;

  const entries: OpencodePermissionEntry[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;

    const tool = entry.tool;
    if (
      typeof tool !== 'string' ||
      !(OPENCODE_PERMISSION_TOOLS as readonly string[]).includes(tool)
    )
      return undefined;
    if (seen.has(tool)) return undefined;
    seen.add(tool);

    if (entry.mode === 'patterns') {
      if (!supportsPatternMap(tool)) return undefined;
      if (!Array.isArray(entry.patterns) || entry.patterns.length === 0) return undefined;

      const patterns: { pattern: string; level: OpencodePermissionLevel }[] = [];
      for (const row of entry.patterns) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
        const rule = row as Record<string, unknown>;
        if (typeof rule.pattern !== 'string') return undefined;
        const pattern = rule.pattern.trim();
        if (!pattern) return undefined;
        if (!isOpencodeLevel(rule.level)) return undefined;
        if (patterns.some((existing) => existing.pattern === pattern)) continue;
        patterns.push({ pattern, level: rule.level });
      }
      if (patterns.length === 0) return undefined;

      entries.push({ tool: tool as OpencodePermissionTool, mode: 'patterns', patterns });
      continue;
    }

    if (entry.mode !== 'level') return undefined;
    if (!isOpencodeLevel(entry.level)) return undefined;
    entries.push({ tool: tool as OpencodePermissionTool, mode: 'level', level: entry.level });
  }

  return { entries };
}
