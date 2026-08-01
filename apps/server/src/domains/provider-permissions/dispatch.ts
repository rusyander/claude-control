import type {
  CodexPermissionDraft,
  ContinuePermissionDraft,
  CursorPermissionDraft,
  GeminiPermissionDraft,
  GoosePermissionDraft,
  KimiPermissionDraft,
  OpencodePermissionDraft,
  ProviderPermissionDraft,
  ProviderPermissionInfo,
  QwenPermissionDraft,
} from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { GOOSE_DEFAULT_MODE, GOOSE_MODES } from '../../lib/goose-yaml.ts';
import { KIMI_DECISIONS, KIMI_DEFAULT_MODE, KIMI_MODES } from '../../lib/kimi-toml.ts';
import {
  OPENCODE_PATTERN_TOOLS,
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
} from '../../lib/opencode-permission.ts';
import {
  APPROVAL_POLICIES,
  CURSOR_RULE_KINDS,
  DEFAULT_APPROVAL,
  DEFAULT_GEMINI_APPROVAL,
  DEFAULT_QWEN_APPROVAL,
  DEFAULT_SANDBOX,
  GEMINI_APPROVAL_MODES,
  QWEN_APPROVAL_MODES,
  SANDBOX_MODES,
} from './constants.ts';
import { parseCodexDraft, readCodexPermissions, saveCodexPermissions } from './codex.ts';
import { parseGeminiDraft, readGeminiPermissions, saveGeminiPermissions } from './gemini.ts';
import { parseQwenDraft, readQwenPermissions, saveQwenPermissions } from './qwen.ts';
import {
  parseContinueDraft,
  readContinuePermissionsValues,
  saveContinuePermissions,
} from './continue.ts';
import { parseCursorDraft, readCursorPermissions, saveCursorPermissions } from './cursor.ts';
import { parseGooseDraft, readGoosePermissionsValues, saveGoosePermissions } from './goose.ts';
import { parseKimiDraft, readKimiPermissionsValues, saveKimiPermissions } from './kimi.ts';
import {
  parseOpencodeDraft,
  readOpencodePermissions,
  saveOpencodePermissions,
} from './opencode.ts';
import type {
  ProviderPermissionsFormat,
  ProviderPermissionsTarget,
  ProviderPermissionsValues,
} from './types.ts';

/**
 * Разбор черновика, чтение, запись и сводка ПО ФОРМАТУ ЦЕЛИ. Здесь только
 * маршрутизация: сама модель прав каждого провайдера живёт в своём модуле.
 */

/**
 * Разобрать желаемые значения прав из тела запроса ПОД ФОРМАТ ЦЕЛИ. Форму
 * задаёт файл провайдера, а не клиент: так подложить codex-черновик в
 * gemini-файл невозможно. Всё, что не прошло проверку, → `undefined` (маршрут
 * ответит 400, в файл не пишем). Схему contracts (zod) в рантайме сервера
 * использовать нельзя, проверяем руками.
 */
export function parseProviderPermissionsDraft(
  body: unknown,
  format: ProviderPermissionsFormat = 'toml',
): ProviderPermissionDraft | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const rec = body as Record<string, unknown>;
  if (format === 'gemini-json') return parseGeminiDraft(rec);
  if (format === 'qwen-json') return parseQwenDraft(rec);
  if (format === 'continue-yaml') return parseContinueDraft(rec);
  if (format === 'cursor-json') return parseCursorDraft(rec);
  if (format === 'goose-yaml') return parseGooseDraft(rec);
  if (format === 'kimi-toml') return parseKimiDraft(rec);
  if (format === 'opencode-json') return parseOpencodeDraft(rec);
  return parseCodexDraft(rec);
}

/**
 * Прочитать текущие права по формату цели. Отсутствующий ключ → дефолт CLI (НЕ
 * пишем его — только показываем). Непарсящийся файл → fail-closed (бросает).
 */
export function readProviderPermissions(
  target: ProviderPermissionsTarget,
): ProviderPermissionsValues {
  const text = readTextFile(target.filePath);
  if (target.format === 'gemini-json') return readGeminiPermissions(text);
  if (target.format === 'qwen-json') return readQwenPermissions(text);
  if (target.format === 'continue-yaml') return readContinuePermissionsValues(text);
  if (target.format === 'cursor-json') return readCursorPermissions(text);
  if (target.format === 'goose-yaml') return readGoosePermissionsValues(text, target);
  if (target.format === 'kimi-toml') return readKimiPermissionsValues(text);
  if (target.format === 'opencode-json') return readOpencodePermissions(text);
  return readCodexPermissions(text);
}

/**
 * Записать права по формату цели. Итог сверяется с намерением до записи —
 * расхождение → fail-closed (не пишем).
 */
export function saveProviderPermissions(
  target: ProviderPermissionsTarget,
  draft: ProviderPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  if (target.format === 'gemini-json')
    return saveGeminiPermissions(target, draft as GeminiPermissionDraft, backupDir);
  if (target.format === 'qwen-json')
    return saveQwenPermissions(target, draft as QwenPermissionDraft, backupDir);
  if (target.format === 'continue-yaml')
    return saveContinuePermissions(target, draft as ContinuePermissionDraft, backupDir);
  if (target.format === 'cursor-json')
    return saveCursorPermissions(target, draft as CursorPermissionDraft, backupDir);
  if (target.format === 'goose-yaml')
    return saveGoosePermissions(target, draft as GoosePermissionDraft, backupDir);
  if (target.format === 'kimi-toml')
    return saveKimiPermissions(target, draft as KimiPermissionDraft, backupDir);
  if (target.format === 'opencode-json')
    return saveOpencodePermissions(target, draft as OpencodePermissionDraft, backupDir);
  return saveCodexPermissions(target, draft as CodexPermissionDraft, backupDir);
}

/**
 * Собрать ответ раздела прав по цели. Одна функция на ОБА маршрута (глобальный и
 * проектный), чтобы модели не разъезжались. Формат файла не распознан →
 * `readOnly:true` с дефолтами на показ (запись такой файл всё равно отвергнет).
 */
export function buildProviderPermissionInfo(
  target: ProviderPermissionsTarget,
): ProviderPermissionInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    filePath: target.filePath,
    cliDetected: target.cliDetected,
  };

  let values: ProviderPermissionsValues | undefined;
  let error: string | undefined;
  try {
    values = readProviderPermissions(target);
  } catch (caught) {
    if (!(caught instanceof UnrecognizedFormatError)) throw caught;
    error = caught.message;
  }
  const readOnly = values === undefined;

  if (target.format === 'gemini-json') {
    const gemini = values?.kind === 'gemini' ? values : undefined;
    return {
      ...base,
      kind: 'gemini',
      format: 'gemini-json',
      approvalMode: gemini?.approvalMode ?? DEFAULT_GEMINI_APPROVAL,
      approvalModes: [...GEMINI_APPROVAL_MODES],
      coreTools: gemini?.coreTools ?? [],
      excludeTools: gemini?.excludeTools ?? [],
      usingDefaults: gemini?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  if (target.format === 'qwen-json') {
    const qwen = values?.kind === 'qwen' ? values : undefined;
    return {
      ...base,
      kind: 'qwen',
      format: 'qwen-json',
      approvalMode: qwen?.approvalMode ?? DEFAULT_QWEN_APPROVAL,
      approvalModes: [...QWEN_APPROVAL_MODES],
      allow: qwen?.allow ?? [],
      ask: qwen?.ask ?? [],
      deny: qwen?.deny ?? [],
      usingDefaults: qwen?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  if (target.format === 'continue-yaml') {
    const cont = values?.kind === 'continue' ? values : undefined;
    return {
      ...base,
      kind: 'continue',
      format: 'continue-yaml',
      allow: cont?.allow ?? [],
      ask: cont?.ask ?? [],
      exclude: cont?.exclude ?? [],
      usingDefaults: cont?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  if (target.format === 'cursor-json') {
    const cursor = values?.kind === 'cursor' ? values : undefined;
    return {
      ...base,
      kind: 'cursor',
      format: 'cursor-json',
      allow: cursor?.allow ?? [],
      deny: cursor?.deny ?? [],
      ruleKinds: [...CURSOR_RULE_KINDS],
      usingDefaults: cursor?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  if (target.format === 'goose-yaml') {
    const goose = values?.kind === 'goose' ? values : undefined;
    return {
      ...base,
      kind: 'goose',
      format: 'goose-yaml',
      mode: goose?.mode ?? GOOSE_DEFAULT_MODE,
      modes: [...GOOSE_MODES],
      usingDefaults: goose?.usingDefaults ?? true,
      // Пофайловые разрешения — показ без правки: путь нужен, чтобы человек
      // знал, какой файл смотреть, даже когда в нём пока ничего нет.
      toolPermissions: goose?.toolPermissions,
      toolPermissionsPath: target.toolPermissionsPath,
      readOnly,
      error,
    };
  }

  if (target.format === 'kimi-toml') {
    const kimi = values?.kind === 'kimi' ? values : undefined;
    return {
      ...base,
      kind: 'kimi',
      format: 'kimi-toml',
      mode: kimi?.mode ?? KIMI_DEFAULT_MODE,
      modes: [...KIMI_MODES],
      rules: kimi?.rules ?? [],
      decisions: [...KIMI_DECISIONS],
      usingDefaults: kimi?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  if (target.format === 'opencode-json') {
    const opencode = values?.kind === 'opencode' ? values : undefined;
    return {
      ...base,
      kind: 'opencode',
      format: 'opencode-json',
      levels: [...OPENCODE_PERMISSION_LEVELS],
      tools: [...OPENCODE_PERMISSION_TOOLS],
      patternTools: [...OPENCODE_PATTERN_TOOLS],
      entries: opencode?.entries ?? [],
      preserved: opencode?.preserved ?? [],
      usingDefaults: opencode?.usingDefaults ?? true,
      readOnly,
      error,
    };
  }

  const codex = values?.kind === 'codex' ? values : undefined;
  return {
    ...base,
    kind: 'codex',
    format: 'toml',
    approvalPolicy: codex?.approvalPolicy ?? DEFAULT_APPROVAL,
    sandboxMode: codex?.sandboxMode ?? DEFAULT_SANDBOX,
    approvalPolicies: [...APPROVAL_POLICIES],
    sandboxModes: [...SANDBOX_MODES],
    usingDefaults: codex?.usingDefaults ?? true,
    readOnly,
    error,
  };
}
