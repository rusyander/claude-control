import type { ContinuePermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import {
  CONTINUE_PERMISSION_KEYS,
  hasContinuePermissionKeys,
  // Низкоуровневая читалка отдаёт голые списки; имя стадии раздела занято
  // адаптером ниже, поэтому здесь она под своим смыслом.
  readContinuePermissions as readContinueLists,
  writeContinuePermissions,
} from '../../lib/continue-yaml.ts';
import { parseToolList } from './normalize.ts';
import { backupNameOf } from './target.ts';
import type { ContinuePermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * CONTINUE (`continue-yaml`) — ОТДЕЛЬНЫЙ файл `~/.continue/permissions.yaml`, а
 * не секция общего конфига. Модель прав у Continue проще всех: НИКАКОГО режима,
 * ровно три списка верхнего уровня — `allow` (выполнять сразу), `ask`
 * (спрашивать), `exclude` (спрятать инструмент от агента). Элементы —
 * задокументированные строки-правила (`Read(*)`, `Bash`, инструмент с шаблоном
 * путей). Правка идёт Document API пакета `yaml`: комментарии и прочие ключи
 * файла целы, пустой список УДАЛЯЕТ свой ключ, а не пишет `[]`.
 */

/**
 * Разобрать черновик прав Continue: три списка правил и НИКАКОГО режима. Правила
 * — непрозрачные строки (панель их синтаксис не толкует, только хранит), поэтому
 * проверяем ровно форму: массив непустых строк без повторов (`parseToolList`).
 */
export function parseContinueDraft(
  rec: Record<string, unknown>,
): ContinuePermissionDraft | undefined {
  const allow = parseToolList(rec.allow);
  const ask = parseToolList(rec.ask);
  const exclude = parseToolList(rec.exclude);
  if (!allow || !ask || !exclude) return undefined;
  return { allow, ask, exclude };
}

/**
 * Прочитать права Continue. Файла нет → дефолты CLI (чтение разрешено, запись
 * инструментов спрашивается) — их панель НЕ пишет, только показывает пустые
 * списки. Файл есть, но все три ключа отсутствуют → тоже «на дефолтах».
 */
export function readContinuePermissions(text: string): ContinuePermissionsValues {
  if (!text.trim()) {
    return { kind: 'continue', allow: [], ask: [], exclude: [], usingDefaults: true };
  }

  const lists = readContinueLists(text);
  return {
    kind: 'continue',
    ...lists,
    // Пустой `exclude: []`, написанный пользователем, — это НЕ дефолт: ключ в
    // файле есть, и раздел обязан показать себя настроенным.
    usingDefaults: !hasContinuePermissionKeys(text),
  };
}

/**
 * Записать три списка в `permissions.yaml`. Пустой список удаляет свой ключ;
 * комментарии и прочие ключи файла сохраняются (Document API). Нет файла →
 * создаётся с теми списками, которые непусты; все три пустые — файл создаётся
 * пустым (записать «ничего» безопаснее, чем придумывать дефолты CLI).
 */
export function saveContinuePermissions(
  target: ProviderPermissionsTarget,
  draft: ContinuePermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const next = writeContinuePermissions(text, {
    allow: draft.allow,
    ask: draft.ask,
    exclude: draft.exclude,
  });

  // Контроль ДО записи: итог читается нашей же моделью и совпал с намерением.
  const check = readContinuePermissions(next);
  for (const key of CONTINUE_PERMISSION_KEYS) {
    if (JSON.stringify(check[key]) !== JSON.stringify(draft[key])) {
      throw new UnrecognizedFormatError();
    }
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
