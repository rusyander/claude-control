import type { GeminiApprovalMode, GeminiPermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  DEFAULT_GEMINI_APPROVAL,
  GEMINI_APPROVAL_MODES,
  GEMINI_CLI_ONLY_APPROVAL_MODES,
} from './constants.ts';
import {
  objectSection,
  parseToolList,
  readStringList,
  stripManagedSectionKeys,
} from './normalize.ts';
import { backupNameOf } from './target.ts';
import type { GeminiPermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * GEMINI (`gemini-json`, GEMINI-2) — три ключа `settings.json` (глобального
 * `~/.gemini/settings.json` и проектного `<проект>/.gemini/settings.json`):
 *  - `general.defaultApprovalMode` — `default` | `auto_edit` | `plan`;
 *  - `coreTools` — белый список инструментов (что разрешено вызывать);
 *  - `excludeTools` — чёрный список; он ПРИОРИТЕТНЕЕ белого.
 * Правятся ТОЛЬКО эти три ключа: соседи внутри `general`, объект `mcpServers` и
 * любые прочие ключи файла сохраняются (проверяется проекцией до записи).
 * Пустой список УДАЛЯЕТ ключ, а не пишет `[]`: пустой `coreTools` означал бы
 * «не разрешено ничего» — молча запрещать инструменты панель не станет.
 *
 * `yolo` В ФАЙЛ НЕ ПИШЕТСЯ НИКОГДА. По документации Gemini это режим только для
 * флага командной строки; записанный в settings.json он валит старт CLI ошибкой
 * enum. Значение отсекается на разборе черновика (маршрут отвечает 400) и ещё раз
 * проверяется перед самой записью — двойная страховка.
 */

/**
 * Форма файла Gemini. Панель ведёт РОВНО `general.defaultApprovalMode` и два
 * списка инструментов; всё прочее (`mcpServers`, соседи внутри `general`) — чужое.
 */
interface RawGeminiSettings {
  general?: Record<string, unknown>;
  coreTools?: unknown;
  excludeTools?: unknown;
  [key: string]: unknown;
}

/**
 * Пользователь прислал режим аппрувов, который Gemini принимает только как флаг
 * CLI (`yolo`). Маршрут отвечает 400 с отдельным объяснением: это не «битый
 * ввод», а осознанный отказ панели портить settings.json.
 */
export function isCliOnlyGeminiApprovalMode(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const mode = (body as Record<string, unknown>).approvalMode;
  return typeof mode === 'string' && GEMINI_CLI_ONLY_APPROVAL_MODES.includes(mode);
}

export function parseGeminiDraft(rec: Record<string, unknown>): GeminiPermissionDraft | undefined {
  const approvalMode = rec.approvalMode;
  // `yolo` не проходит именно здесь — он не входит в GEMINI_APPROVAL_MODES.
  if (
    typeof approvalMode !== 'string' ||
    !GEMINI_APPROVAL_MODES.includes(approvalMode as GeminiApprovalMode)
  )
    return undefined;

  const coreTools = parseToolList(rec.coreTools);
  const excludeTools = parseToolList(rec.excludeTools);
  if (!coreTools || !excludeTools) return undefined;

  return { approvalMode: approvalMode as GeminiApprovalMode, coreTools, excludeTools };
}

/**
 * Прочитать права Gemini. Отсутствующий режим → дефолт `default`. Режим вне
 * набора (например, вручную вписанный `yolo`) показываем как дефолт, но раздел
 * при этом НЕ считается «на дефолтах»: интерфейс подскажет, что значение в файле
 * панель не поддерживает и сохранение его заменит.
 */
export function readGeminiPermissions(text: string): GeminiPermissionsValues {
  if (!text.trim()) {
    return {
      kind: 'gemini',
      approvalMode: DEFAULT_GEMINI_APPROVAL,
      coreTools: [],
      excludeTools: [],
      usingDefaults: true,
    };
  }

  const config = parseProviderJsonObject<RawGeminiSettings>(text);
  const rawMode = objectSection(config, 'general')?.defaultApprovalMode;
  const coreTools = readStringList(config.coreTools);
  const excludeTools = readStringList(config.excludeTools);

  const known =
    typeof rawMode === 'string' && GEMINI_APPROVAL_MODES.includes(rawMode as GeminiApprovalMode);

  return {
    kind: 'gemini',
    approvalMode: known ? (rawMode as GeminiApprovalMode) : DEFAULT_GEMINI_APPROVAL,
    coreTools: coreTools ?? [],
    excludeTools: excludeTools ?? [],
    usingDefaults: rawMode === undefined && coreTools === undefined && excludeTools === undefined,
  };
}

/**
 * Проекция «всё, кроме управляемых панелью ключей». По ней результат сверяется с
 * оригиналом: если хоть один чужой ключ (в том числе соседи внутри `general` и
 * весь `mcpServers`) изменился — запись отменяется.
 *
 * Экспортирована ради собственного теста: сегодняшний путь записи вложенных
 * ключей не трогает, поэтому чувствительность страховки снаружи не наблюдаема —
 * а именно она здесь и ломалась (#56).
 */
export function geminiOtherKeysProjection(config: RawGeminiSettings): string {
  const rest: Record<string, unknown> = { ...config };
  delete rest.coreTools;
  delete rest.excludeTools;

  stripManagedSectionKeys(rest, 'general', ['defaultApprovalMode']);

  // Ключи сортируем РЕКУРСИВНО (`stableJson`, как у всех соседних проекций):
  // сравниваем содержимое, а не порядок обхода. Прежний
  // `JSON.stringify(rest, Object.keys(rest).sort())` был не сортировкой, а
  // фильтром-разрешением, который JSON.stringify применяет на КАЖДОМ уровне
  // вложенности: все вложенные объекты сериализовались в `{}`, и страховка не
  // видела правок ни внутри `mcpServers`, ни у соседей внутри `general`.
  return stableJson(rest);
}

/**
 * Записать права Gemini в settings.json, поменяв ТОЛЬКО три ключа. Пустой список
 * инструментов удаляет свой ключ (пустой `coreTools` означал бы «ничего нельзя»).
 * Нет файла → создаётся с одним `general.defaultApprovalMode`.
 */
export function saveGeminiPermissions(
  target: ProviderPermissionsTarget,
  draft: GeminiPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  // Двойная страховка: даже если сюда как-то попал запрещённый режим, в файл он
  // не уйдёт (в settings.json `yolo` валит старт Gemini ошибкой enum).
  if (!GEMINI_APPROVAL_MODES.includes(draft.approvalMode)) throw new UnrecognizedFormatError();

  const text = readTextFile(target.filePath);
  const original: RawGeminiSettings = text.trim()
    ? parseProviderJsonObject<RawGeminiSettings>(text)
    : {};

  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawGeminiSettings = text.trim()
    ? parseProviderJsonObject<RawGeminiSettings>(text)
    : {};

  const general = objectSection(config, 'general') ?? {};
  general.defaultApprovalMode = draft.approvalMode;
  config.general = general;

  if (draft.coreTools.length > 0) config.coreTools = draft.coreTools;
  else delete config.coreTools;
  if (draft.excludeTools.length > 0) config.excludeTools = draft.excludeTools;
  else delete config.excludeTools;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, три ключа совпали с намерением, а все
  // прочие ключи файла (включая mcpServers и соседей внутри general) не тронуты.
  const check = readGeminiPermissions(next);
  if (
    check.approvalMode !== draft.approvalMode ||
    JSON.stringify(check.coreTools) !== JSON.stringify(draft.coreTools) ||
    JSON.stringify(check.excludeTools) !== JSON.stringify(draft.excludeTools)
  ) {
    throw new UnrecognizedFormatError();
  }
  if (
    geminiOtherKeysProjection(original) !==
    geminiOtherKeysProjection(parseProviderJsonObject<RawGeminiSettings>(next))
  ) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm по умолчанию: файл пересобран из JSON.stringify (LF, без BOM),
  // поэтому форму пользовательского файла возвращает safe-io.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
