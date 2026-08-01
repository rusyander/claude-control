import type {
  OpencodePermissionDraft,
  OpencodePermissionEntry,
  OpencodePermissionLevel,
  OpencodePermissionTool,
} from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  applyOpencodePermission,
  readOpencodePermission,
  supportsPatternMap,
  type OpencodeToolPermission,
} from '../../lib/opencode-permission.ts';
import { backupNameOf } from './target.ts';
import type { OpencodePermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * OPENCODE (`opencode-json`, OPENCODE-1) — ключ `permission` файла
 * `~/.config/opencode/opencode.json` (и проектного `<проект>/opencode.json`):
 *  - уровень у инструмента — РОВНО `allow` | `deny` | `ask`;
 *  - задокументированные инструменты — `edit`, `bash`, `webfetch`;
 *  - расширенная форма: у `bash` вместо уровня допустима КАРТА ШАБЛОНОВ
 *    (`{"*":"ask","git *":"allow","git push *":"deny"}`) — панель её читает и правит.
 * Правится ТОЛЬКО ключ `permission`: `$schema`, `model`, `mcp`, `agent` и прочие
 * ключи файла сохраняются по значениям (проверяется проекцией до записи). Записи
 * ВНУТРИ `permission`, которых панель не ведёт (чужие имена инструментов,
 * непонятая форма), сохраняются как есть и показываются только для чтения;
 * попытка перезаписать такую запись → fail-closed. Переопределения прав на уровне
 * АГЕНТА (`agent.<имя>.permission`) вне области задачи и не затрагиваются.
 * Пустой результат УДАЛЯЕТ ключ `permission`, а не пишет `{}`.
 */

/** Форма файла OpenCode: правится ТОЛЬКО ключ `permission`, прочее — как есть. */
interface RawOpencodeConfig {
  permission?: unknown;
  [key: string]: unknown;
}

/** Уровень прав OpenCode из тела запроса: строка строго из набора. */
function isOpencodeLevel(value: unknown): value is OpencodePermissionLevel {
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

/**
 * Прочитать права OpenCode. Нет файла или нет ключа `permission` → ограничений
 * нет (OpenCode ничего не ограничивает по умолчанию; дефолт панель НЕ пишет).
 * Файл не парсится или `permission` не объект → fail-closed (бросает).
 */
export function readOpencodePermissions(text: string): OpencodePermissionsValues {
  if (!text.trim()) {
    return { kind: 'opencode', entries: [], preserved: [], usingDefaults: true };
  }

  const config = parseProviderJsonObject<RawOpencodeConfig>(text);
  const state = readOpencodePermission(config.permission);

  return {
    kind: 'opencode',
    entries: state.tools,
    preserved: state.preserved,
    usingDefaults: !state.present,
  };
}

/**
 * Проекция «всё, кроме ведомых панелью инструментов». По ней результат сверяется с
 * оригиналом: изменился любой чужой ключ файла (`$schema`, `model`, `mcp`, `agent`,
 * …) либо любая НЕ ведомая запись внутри `permission` — запись отменяется.
 *
 * Ключи сортируются рекурсивно (`stableJson`): сравнивается содержимое на любой
 * глубине, а не порядок обхода.
 */
function opencodeOtherKeysProjection(config: RawOpencodeConfig): string {
  const rest: Record<string, unknown> = { ...config };

  const permission = config.permission;
  if (permission && typeof permission === 'object' && !Array.isArray(permission)) {
    const managed = new Set<string>(readOpencodePermission(permission).tools.map((t) => t.tool));
    const permissionRest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(permission as Record<string, unknown>)) {
      if (!managed.has(key)) permissionRest[key] = value;
    }
    if (Object.keys(permissionRest).length > 0) rest.permission = permissionRest;
    else delete rest.permission;
  }

  return stableJson(rest);
}

/**
 * Записать права OpenCode, поменяв ТОЛЬКО ключ `permission`.
 *
 * Инструмент из черновика пишется уровнем-строкой либо картой шаблонов; ведомый
 * инструмент, которого в черновике нет, УДАЛЯЕТСЯ; запись, которую панель не
 * ведёт, остаётся байт-в-байт (перезаписать её черновиком нельзя — fail-closed).
 * Пустой результат УДАЛЯЕТ ключ `permission` целиком, а не пишет `{}`.
 * Нет файла → создаётся только с ключом `permission`.
 */
export function saveOpencodePermissions(
  target: ProviderPermissionsTarget,
  draft: OpencodePermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  // Двойная страховка: даже если сюда попал уровень вне набора, в файл он не уйдёт.
  for (const entry of draft.entries) {
    if (entry.mode === 'level' && !isOpencodeLevel(entry.level))
      throw new UnrecognizedFormatError();
    if (entry.mode === 'patterns') {
      if (!supportsPatternMap(entry.tool) || !entry.patterns?.length)
        throw new UnrecognizedFormatError();
      for (const rule of entry.patterns) {
        if (!rule.pattern.trim() || !isOpencodeLevel(rule.level))
          throw new UnrecognizedFormatError();
      }
    }
  }

  const text = readTextFile(target.filePath);
  const original: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};

  const entries = draft.entries as OpencodeToolPermission[];
  const permission = applyOpencodePermission(config.permission, entries);
  if (Object.keys(permission).length > 0) config.permission = permission;
  else delete config.permission;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, заданные инструменты совпали с
  // намерением, а все прочие ключи файла и не ведомые записи `permission` целы.
  const check = readOpencodePermissions(next);
  if (stableJson(check.entries) !== stableJson(entries)) throw new UnrecognizedFormatError();
  if (
    opencodeOtherKeysProjection(original) !==
    opencodeOtherKeysProjection(parseProviderJsonObject<RawOpencodeConfig>(next))
  ) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm по умолчанию: файл пересобран из JSON.stringify (LF, без BOM),
  // поэтому форму пользовательского файла (BOM/CRLF) возвращает safe-io.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
