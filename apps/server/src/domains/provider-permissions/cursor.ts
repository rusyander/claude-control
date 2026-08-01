import type { CursorPermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  objectSection,
  parseToolList,
  readStringList,
  stripManagedSectionKeys,
} from './normalize.ts';
import { backupNameOf } from './target.ts';
import type { CursorPermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * CURSOR (`cursor-json`, CURSOR-2) — ключ `permissions` файла
 * `~/.cursor/cli-config.json` (и проектного `<проект>/.cursor/cli.json`, у
 * которого имя ДРУГОЕ и который держит только права):
 *  - `permissions.allow` — выполнять без вопроса;
 *  - `permissions.deny` — запретить; по документации `deny` ПРИОРИТЕТНЕЕ `allow`.
 * Ни режима-переключателя, ни третьего списка (`ask`) у Cursor нет — это вся
 * модель целиком. Правила (`Shell(git status)`, `Read(src\**)`, `Write(...)`,
 * `WebFetch(домен)`, `Mcp(сервер:инструмент)`) панель НЕ толкует и хранит как есть.
 * Правится ТОЛЬКО ключ `permissions`: `version`, `editor` и прочие настройки CLI
 * в том же файле сохраняются по значениям (проверяется проекцией до записи).
 * Пустой список УДАЛЯЕТ свой ключ, пустые оба — весь объект `permissions`.
 */

/** Ключи внутри `permissions`, которые панель ведёт. */
const CURSOR_MANAGED_KEYS = ['allow', 'deny'] as const;

/**
 * Форма файла Cursor. Панель ведёт РОВНО два списка внутри `permissions`; всё
 * прочее (`version`, `editor`, любые будущие ключи CLI) — чужое и сохраняется.
 */
interface RawCursorConfig {
  permissions?: unknown;
  [key: string]: unknown;
}

/**
 * Разобрать черновик прав Cursor: ровно два списка правил. Формы правил
 * (`Shell(...)`, `Read(...)`, …) панель НЕ проверяет: документация допускает
 * шаблоны и синтаксис `команда:аргументы`, и отсев «непонятного» вырезал бы
 * рабочие правила пользователя. Проверяется ровно то, что можно проверить не
 * гадая, — что это непустые однострочные строки (см. `parseToolList`).
 */
export function parseCursorDraft(rec: Record<string, unknown>): CursorPermissionDraft | undefined {
  const allow = parseToolList(rec.allow);
  const deny = parseToolList(rec.deny);
  if (!allow || !deny) return undefined;
  return { allow, deny };
}

/**
 * Прочитать права Cursor. Файла нет или он пуст → дефолты CLI (панель их НЕ
 * пишет, показывает пустые списки). Ключ `permissions` есть, но не объект, или
 * список не массив строк → fail-closed: форма не наша, править вслепую нельзя.
 */
export function readCursorPermissions(text: string): CursorPermissionsValues {
  if (!text.trim()) return { kind: 'cursor', allow: [], deny: [], usingDefaults: true };

  const config = parseProviderJsonObject<RawCursorConfig>(text);
  const permissions = objectSection(config, 'permissions');
  if (permissions === undefined) {
    return { kind: 'cursor', allow: [], deny: [], usingDefaults: true };
  }

  // Разбор списка тот же, что у Qwen: не массив строк → форма чужая.
  const allow = readStringList(permissions.allow);
  const deny = readStringList(permissions.deny);

  return {
    kind: 'cursor',
    allow: allow ?? [],
    deny: deny ?? [],
    // Ключ `permissions` в файле ЕСТЬ — раздел настроен, даже если оба списка
    // пусты: пустой `"allow": []` пользователь написал сам.
    usingDefaults: false,
  };
}

/**
 * Проекция «всё, кроме ведомых панелью ключей». Опустевший после вычитания
 * `permissions` объект из проекции убирается — иначе `{}` и «ключа не было»
 * считались бы разными и запись падала бы на здоровом файле. Форма не наша
 * (`permissions` не объект) — ключ из проекции выбрасывается целиком.
 */
function cursorOtherKeysProjection(config: RawCursorConfig): string {
  const rest: Record<string, unknown> = { ...config };
  if (!stripManagedSectionKeys(rest, 'permissions', CURSOR_MANAGED_KEYS)) {
    delete rest.permissions;
  }
  return stableJson(rest);
}

/**
 * Записать права Cursor, поменяв ТОЛЬКО `permissions.allow` и `permissions.deny`.
 * Пустой список удаляет свой ключ; пустые оба — весь объект `permissions` (писать
 * `{}` панель не станет). Нет файла → создаётся с одним ключом `permissions`;
 * `version` и прочие настройки CLI панель не выдумывает.
 */
export function saveCursorPermissions(
  target: ProviderPermissionsTarget,
  draft: CursorPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  // Fail-closed на ВХОДЕ: существующий файл обязан читаться нашей моделью.
  readCursorPermissions(text);

  const original: RawCursorConfig = text.trim()
    ? parseProviderJsonObject<RawCursorConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawCursorConfig = text.trim() ? parseProviderJsonObject<RawCursorConfig>(text) : {};

  const section = config.permissions;
  const permissions: Record<string, unknown> =
    section && typeof section === 'object' && !Array.isArray(section)
      ? { ...(section as Record<string, unknown>) }
      : {};

  if (draft.allow.length > 0) permissions.allow = draft.allow;
  else delete permissions.allow;
  if (draft.deny.length > 0) permissions.deny = draft.deny;
  else delete permissions.deny;

  if (Object.keys(permissions).length > 0) config.permissions = permissions;
  else delete config.permissions;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог читается нашей же моделью, совпал с намерением, а
  // прочие ключи файла (`version`, `editor`, соседи внутри `permissions`) целы.
  const check = readCursorPermissions(next);
  if (
    JSON.stringify(check.allow) !== JSON.stringify(draft.allow) ||
    JSON.stringify(check.deny) !== JSON.stringify(draft.deny)
  ) {
    throw new UnrecognizedFormatError();
  }
  if (
    cursorOtherKeysProjection(original) !==
    cursorOtherKeysProjection(parseProviderJsonObject<RawCursorConfig>(next))
  ) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
