import type { KimiPermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import {
  KIMI_DECISIONS,
  KIMI_DEFAULT_MODE,
  KIMI_MODES,
  readKimiMode,
  readKimiRules,
  writeKimiPermissions,
  type KimiDecision,
  type KimiMode,
  type KimiPermissionRule,
} from '../../lib/kimi-toml.ts';
import { backupNameOf } from './target.ts';
import type { KimiPermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * KIMI CODE (`kimi-toml`) — режим корня `default_permission_mode` и
 * упорядоченный блок правил `[[permission.rules]]` в `config.toml`. Хирургия
 * внутри `lib/kimi-toml.ts`: прочие ключи файла (провайдеры, модели, хуки)
 * остаются байт-в-байт.
 */

/**
 * Разобрать черновик прав Kimi: режим `default_permission_mode` + ВЕСЬ список
 * правил. Правило — ровно два поля: `decision` из набора и непустой `pattern`
 * (синтаксис шаблона панель не толкует, только хранит). Порядок правил значим и
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

/**
 * Прочитать права Kimi. Ни режима, ни правил → дефолт CLI (`manual`: без ключа
 * Kimi спрашивает подтверждение), и панель его НЕ пишет. Значение режима вне
 * набора показываем дефолтом, но «на дефолтах» раздел уже не считается: в файле
 * что-то задано. Чужая форма блока правил → fail-closed (бросает).
 */
export function readKimiPermissionsValues(text: string): KimiPermissionsValues {
  if (!text.trim()) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }

  const raw = readKimiMode(text);
  const rules = readKimiRules(text);
  if (raw === undefined && rules.length === 0) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }
  const known = raw !== undefined && (KIMI_MODES as readonly string[]).includes(raw);
  return {
    kind: 'kimi',
    mode: known ? (raw as KimiMode) : KIMI_DEFAULT_MODE,
    rules,
    usingDefaults: false,
  };
}

/**
 * Записать режим и правила Kimi. Хирургия внутри `lib/kimi-toml.ts`: прочие
 * ключи `config.toml` (провайдеры, модели, хуки) остаются байт-в-байт. Контроль
 * до записи: итог читается нашей же моделью и совпал с намерением.
 */
export function saveKimiPermissions(
  target: ProviderPermissionsTarget,
  draft: KimiPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const rules = draft.rules.map((rule) => ({
    decision: rule.decision as KimiDecision,
    pattern: rule.pattern,
  }));
  const next = writeKimiPermissions(text, draft.mode as KimiMode, rules);

  if (readKimiMode(next) !== draft.mode) throw new UnrecognizedFormatError();
  if (JSON.stringify(readKimiRules(next)) !== JSON.stringify(rules)) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    // Итог собран ИЗ ИСХОДНОГО текста хирургией (как у codex): общая нормализация
    // формы сломала бы байт-в-байт на файле со смешанными окончаниями строк.
    preserveForm: false,
  });
}
