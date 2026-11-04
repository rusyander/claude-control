import type { KimiPermissionDraft, KimiPermissionRule } from '../provider-permissions.ts';
import { KIMI_DECISIONS, KIMI_MODES, type KimiDecision, type KimiMode } from '../vocabulary.ts';

/**
 * Разобрать черновик прав Kimi: режим `default_permission_mode` + ВЕСЬ список
 * правил. Правило — ровно два поля: `decision` из набора и непустой `pattern`
 * (синтаксис шаблона не толкуется, только хранится). Порядок правил значим и
 * сохраняется как прислали; полный повтор (то же решение с тем же шаблоном)
 * отбрасывается — две одинаковые строки в файле пользы не несут.
 */
export function parseKimiDraft(rec: Record<string, unknown>): KimiPermissionDraft | undefined {
  const mode = rec.mode;
  if (typeof mode !== 'string' || !(KIMI_MODES as readonly string[]).includes(mode)) {
    return undefined;
  }
  if (!Array.isArray(rec.rules)) return undefined;

  const rules: KimiPermissionRule[] = [];
  const seen = new Set<string>();
  for (const item of rec.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const { decision, pattern } = item as Record<string, unknown>;
    if (typeof decision !== 'string' || !(KIMI_DECISIONS as readonly string[]).includes(decision)) {
      return undefined;
    }
    if (typeof pattern !== 'string') return undefined;
    // Пустая строка — это пустая строка формы, а не ошибка: как в списках
    // Qwen/Continue, такую запись молча выбрасываем.
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    const key = `${decision}\u0000${trimmed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ decision: decision as KimiDecision, pattern: trimmed });
  }

  return { mode: mode as KimiMode, rules };
}
