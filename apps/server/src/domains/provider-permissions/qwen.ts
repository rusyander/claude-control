import type { QwenApprovalMode, QwenPermissionDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import { DEFAULT_QWEN_APPROVAL, QWEN_APPROVAL_MODES } from './constants.ts';
import {
  objectSection,
  parseToolList,
  readStringList,
  stripManagedSectionKeys,
} from './normalize.ts';
import { backupNameOf } from './target.ts';
import type { ProviderPermissionsTarget, QwenPermissionsValues } from './types.ts';

/**
 * QWEN CODE (`qwen-json`) — ключи `settings.json` (глобального
 * `<QWEN_HOME>/settings.json` и проектного `<проект>/.qwen/settings.json`):
 *  - `tools.approvalMode` — `default` | `plan` | `auto-edit` | `auto` | `yolo`;
 *  - `permissions.allow` / `permissions.ask` / `permissions.deny` — списки ПРАВИЛ
 *    (`Bash(git push *)`, `Read(/src/**)`); `deny` приоритетнее прочих.
 * Qwen — форк Gemini CLI, но ключи прав у него ДРУГИЕ: писать сюда gemini-форму
 * значило бы писать не туда. Устаревшие `tools.core` / `tools.allowed` /
 * `tools.exclude` панель НЕ пишет (документация мигрирует их в `permissions.*`) —
 * они сохраняются как чужие ключи, если уже есть в файле.
 * `yolo` здесь РАЗРЕШЁН, в отличие от Gemini: у Qwen это задокументированное
 * значение файла настроек, а не только флаг CLI.
 * Пустой список УДАЛЯЕТ свой ключ, пустые все три — весь объект `permissions`.
 */

/**
 * Форма файла Qwen Code. Панель ведёт РОВНО `tools.approvalMode` и три списка
 * внутри `permissions`; всё прочее (в том числе соседи внутри тех же секций,
 * `mcpServers`, устаревшие `tools.core`/`allowed`/`exclude`) — чужое.
 */
interface RawQwenSettings {
  tools?: unknown;
  permissions?: unknown;
  [key: string]: unknown;
}

/**
 * Разобрать черновик прав Qwen Code: режим аппрувов + три списка правил. Правила
 * — непрозрачные строки (панель их синтаксис не толкует, только хранит), поэтому
 * проверяем ровно форму: массив непустых строк без повторов (`parseToolList`).
 */
export function parseQwenDraft(rec: Record<string, unknown>): QwenPermissionDraft | undefined {
  const approvalMode = rec.approvalMode;
  if (
    typeof approvalMode !== 'string' ||
    !QWEN_APPROVAL_MODES.includes(approvalMode as QwenApprovalMode)
  )
    return undefined;

  const allow = parseToolList(rec.allow);
  const ask = parseToolList(rec.ask);
  const deny = parseToolList(rec.deny);
  if (!allow || !ask || !deny) return undefined;

  return { approvalMode: approvalMode as QwenApprovalMode, allow, ask, deny };
}

/**
 * Прочитать права Qwen Code. Отсутствующий режим → дефолт `default`. Режим вне
 * набора показываем как дефолт, но раздел при этом НЕ считается «на дефолтах»:
 * интерфейс подскажет, что значение из файла панель не поддерживает и сохранение
 * его заменит.
 */
export function readQwenPermissions(text: string): QwenPermissionsValues {
  if (!text.trim()) {
    return {
      kind: 'qwen',
      approvalMode: DEFAULT_QWEN_APPROVAL,
      allow: [],
      ask: [],
      deny: [],
      usingDefaults: true,
    };
  }

  const config = parseProviderJsonObject<RawQwenSettings>(text);
  const rawMode = objectSection(config, 'tools')?.approvalMode;
  const permissions = objectSection(config, 'permissions');
  const allow = readStringList(permissions?.allow);
  const ask = readStringList(permissions?.ask);
  const deny = readStringList(permissions?.deny);

  const known =
    typeof rawMode === 'string' && QWEN_APPROVAL_MODES.includes(rawMode as QwenApprovalMode);

  return {
    kind: 'qwen',
    approvalMode: known ? (rawMode as QwenApprovalMode) : DEFAULT_QWEN_APPROVAL,
    allow: allow ?? [],
    ask: ask ?? [],
    deny: deny ?? [],
    usingDefaults:
      rawMode === undefined && allow === undefined && ask === undefined && deny === undefined,
  };
}

/**
 * Проекция «всё, кроме ведомых панелью ключей»: по ней результат сверяется с
 * оригиналом до записи. Секция, оставшаяся пустой после вычитания своих ключей,
 * из проекции убирается — иначе `{}` и «ключа не было» считались бы разными.
 * Сортировка ключей РЕКУРСИВНАЯ (`stableJson`): сравнивается содержимое, а не
 * порядок обхода, и вложенные объекты тоже.
 */
function qwenOtherKeysProjection(config: RawQwenSettings): string {
  const rest: Record<string, unknown> = { ...config };

  stripManagedSectionKeys(rest, 'tools', ['approvalMode']);
  stripManagedSectionKeys(rest, 'permissions', ['allow', 'ask', 'deny']);

  return stableJson(rest);
}

/**
 * Записать права Qwen Code в settings.json, поменяв ТОЛЬКО `tools.approvalMode` и
 * три списка внутри `permissions`. Пустой список удаляет свой ключ; пустые все
 * три — весь объект `permissions` (писать `{}` панель не станет). Нет файла →
 * создаётся с одним `tools.approvalMode`.
 */
export function saveQwenPermissions(
  target: ProviderPermissionsTarget,
  draft: QwenPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  // Двойная страховка: значение вне набора в файл не уйдёт даже в обход разбора.
  if (!QWEN_APPROVAL_MODES.includes(draft.approvalMode)) throw new UnrecognizedFormatError();

  const text = readTextFile(target.filePath);
  const original: RawQwenSettings = text.trim()
    ? parseProviderJsonObject<RawQwenSettings>(text)
    : {};

  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawQwenSettings = text.trim() ? parseProviderJsonObject<RawQwenSettings>(text) : {};

  const tools = objectSection(config, 'tools') ?? {};
  tools.approvalMode = draft.approvalMode;
  config.tools = tools;

  const permissions = objectSection(config, 'permissions') ?? {};
  const lists: [keyof QwenPermissionDraft & ('allow' | 'ask' | 'deny'), string[]][] = [
    ['allow', draft.allow],
    ['ask', draft.ask],
    ['deny', draft.deny],
  ];
  for (const [key, list] of lists) {
    if (list.length > 0) permissions[key] = list;
    else delete permissions[key];
  }
  if (Object.keys(permissions).length > 0) config.permissions = permissions;
  else delete config.permissions;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, ведомые ключи совпали с намерением, а
  // все прочие ключи файла (включая mcpServers и соседей внутри секций) целы.
  const check = readQwenPermissions(next);
  if (
    check.approvalMode !== draft.approvalMode ||
    JSON.stringify(check.allow) !== JSON.stringify(draft.allow) ||
    JSON.stringify(check.ask) !== JSON.stringify(draft.ask) ||
    JSON.stringify(check.deny) !== JSON.stringify(draft.deny)
  ) {
    throw new UnrecognizedFormatError();
  }
  if (
    qwenOtherKeysProjection(original) !==
    qwenOtherKeysProjection(parseProviderJsonObject<RawQwenSettings>(next))
  ) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
