import type { KimiPermissionDraft } from '@agentdeck/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml/codex-toml.ts';
import {
  KIMI_DEFAULT_MODE,
  readKimiMode,
  readKimiRules,
  writeKimiPermissions,
  type KimiDecision,
  type KimiMode,
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
 * Прочитать права Kimi. Ни режима, ни правил → дефолт CLI (`manual`: без ключа
 * Kimi спрашивает подтверждение), и панель его НЕ пишет. Значение режима вне
 * набора (`default`, `plan`) и чужая форма блока правил → fail-closed (бросает,
 * у режима — с названной причиной): раздел только для чтения, а не тихая подмена.
 */
export function readKimiPermissions(text: string): KimiPermissionsValues {
  if (!text.trim()) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }

  const raw = readKimiMode(text);
  const rules = readKimiRules(text);
  if (raw === undefined && rules.length === 0) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }
  return {
    kind: 'kimi',
    mode: raw ?? KIMI_DEFAULT_MODE,
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
