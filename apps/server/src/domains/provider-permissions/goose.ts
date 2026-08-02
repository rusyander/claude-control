import type { GoosePermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import {
  GOOSE_DEFAULT_MODE,
  GOOSE_MODES,
  readGooseMode,
  writeGooseMode,
  type GooseMode,
} from '../../lib/goose-yaml.ts';
import { readGooseToolPermissions } from '../../lib/goose-permission-file.ts';
import { backupNameOf } from './target.ts';
import type { GoosePermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * GOOSE (`goose-yaml`) — ОДИН скалярный ключ КОРНЯ `config.yaml`: `GOOSE_MODE`
 * (`auto` — выполнять всё без вопросов, `approve` — только по заданным
 * разрешениям, `smart_approve` — авто-одобрение безопасных вызовов, `chat` — без
 * запуска инструментов вовсе). Ни списков, ни второго ключа у этой модели нет.
 * Пофайловые разрешения инструментов Goose держит в `permission.yaml` — панель
 * его НЕ ведёт (формат не разбирался), правится ровно `GOOSE_MODE`, соседние
 * ключи и расширения того же файла целы.
 */

/**
 * Разобрать черновик прав Goose: ОДИН ключ `mode` из задокументированного
 * набора (`auto`, `approve`, `smart_approve`, `chat`). Списков у Goose нет.
 */
export function parseGooseDraft(rec: Record<string, unknown>): GoosePermissionDraft | undefined {
  const mode = rec.mode;
  if (typeof mode !== 'string' || !(GOOSE_MODES as readonly string[]).includes(mode)) {
    return undefined;
  }
  return { mode: mode as GooseMode };
}

/**
 * Прочитать режим Goose. Ключа нет → дефолт CLI (`auto`: именно в нём идут
 * неинтерактивные сессии), и панель его НЕ пишет. Значение вне набора показываем
 * дефолтом, но раздел НЕ считается «на дефолтах»: в файле что-то задано, и
 * пользователь должен это видеть.
 */
export function readGoosePermissions(
  text: string,
  target: ProviderPermissionsTarget,
): GoosePermissionsValues {
  // Пофайловые разрешения живут в СОСЕДНЕМ файле и от режима не зависят: их
  // читаем всегда, даже когда `GOOSE_MODE` в config.yaml не задан.
  const toolPermissions = target.toolPermissionsPath
    ? readGooseToolPermissions(readTextFile(target.toolPermissionsPath))
    : undefined;

  if (!text.trim())
    return { kind: 'goose', mode: GOOSE_DEFAULT_MODE, usingDefaults: true, toolPermissions };

  const raw = readGooseMode(text);
  if (raw === undefined)
    return { kind: 'goose', mode: GOOSE_DEFAULT_MODE, usingDefaults: true, toolPermissions };
  const known = (GOOSE_MODES as readonly string[]).includes(raw);
  return {
    kind: 'goose',
    mode: known ? (raw as GooseMode) : GOOSE_DEFAULT_MODE,
    usingDefaults: false,
    toolPermissions,
  };
}

/**
 * Записать `GOOSE_MODE`, сохранив расширения, прочие ключи и комментарии файла.
 * Контроль до записи: итог читается нашей же моделью и совпал с намерением.
 */
export function saveGoosePermissions(
  target: ProviderPermissionsTarget,
  draft: GoosePermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const next = writeGooseMode(text, draft.mode as GooseMode);
  if (readGooseMode(next) !== draft.mode) throw new UnrecognizedFormatError();

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
