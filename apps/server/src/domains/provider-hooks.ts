import type {
  AppSettings,
  ProviderHookAction,
  ProviderHookPatternGroup,
  ProviderHooksDraft,
  ProviderHooksInfo,
  ProviderHooksScope,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../lib/provider-json.ts';
import {
  applyOpencodeHook,
  readOpencodeHook,
  type OpencodeHookAction,
  type OpencodeHookDraft,
  type OpencodeHookPatternGroup,
} from '../lib/opencode-hook.ts';

/**
 * Раздел «Хуки» у НЕ-Claude провайдера (OPENCODE-3).
 *
 * У Claude хуки — свой богатый раздел (`domains/hooks.ts`, маршруты `/api/hooks`,
 * события `PreToolUse`/`PostToolUse`, матчеры, shell-команды). Он НЕ МЕНЯЕТСЯ:
 * модель у OpenCode принципиально другая, и мешать их в одном домене нельзя.
 *
 * У OpenCode это ключ `experimental.hook` в `opencode.json` (глобальном и
 * проектном) с РОВНО ДВУМЯ задокументированными событиями (`file_edited`,
 * `session_completed`) и действиями-argv. Разбор формата — `lib/opencode-hook.ts`
 * (новых парсеров JSON здесь нет: файл читается общим `parseProviderJsonObject`).
 *
 * ЧЕСТНО: `experimental` OpenCode сам объявляет нестабильным разделом, так что
 * раздел помечен «экспериментально у самого OpenCode».
 *
 * ЗАЩИТЫ, как во всех провайдер-разделах: валидация черновика ДО записи (400),
 * fail-closed на непонятом файле (422, файл не трогается), сохранение всех чужих
 * ключей с проверкой проекции ДО записи, бэкап + атомарная запись, BOM/CRLF.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
interface ProviderHooksSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Формат хранилища хуков, поддержанный разделом. */
export type ProviderHooksFormat = 'opencode-json';

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderHooksTarget {
  provider: ConfigProvider;
  format: ProviderHooksFormat;
  scope: ProviderHooksScope;
  filePath: string;
  /**
   * Имя резервной копии. По умолчанию — `<id>-<basename>` (глобальный файл);
   * проектный уровень передаёт своё (`<id>-project-<basename>`).
   */
  backupName?: string;
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное. */
function backupNameOf(target: ProviderHooksTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель глобального раздела хуков — или `undefined`, если активный провайдер его
 * не поддерживает (маршрут ответит 4xx). Поддержан, только когда `hooks` =
 * `ready` И задан `hooksConfig`. Claude сюда не попадает: `hooksConfig` у него не
 * задан, он на своих маршрутах.
 */
export function resolveProviderHooksTarget(
  store: ProviderHooksSettingsSource,
): ProviderHooksTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.hooks !== 'ready' || !provider.hooksConfig) return undefined;

  return {
    provider,
    format: provider.hooksConfig.format,
    scope: 'global',
    filePath: provider.hooksConfig.path(store.getSettings().claudeDirOverride),
  };
}

// --- Разбор черновика (валидация ДО записи) ----------------------------------

/** Максимум, чтобы черновик не превращался в способ забить конфиг мусором. */
const MAX_PATTERNS = 200;
const MAX_ACTIONS = 100;
const MAX_ARGV = 100;
const MAX_ENV_VARS = 100;

/**
 * Строка без управляющих символов (аргумент argv, шаблон, значение
 * переменной). Перевод строки внутри argv-элемента почти наверняка означает,
 * что в поле вставили не то, а нулевой байт в конфиге не имеет смысла вовсе.
 *
 * Проверяем кодами, а не регулярным выражением: писать управляющие символы
 * прямо в исходник нельзя, а экранированный класс в регулярке читается хуже.
 */
function isCleanString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Разобрать ОДНО действие черновика.
 *
 * `command` обязан быть НЕПУСТЫМ массивом непустых строк — это argv, а не
 * shell-строка: пустой элемент означал бы пустой аргумент, а пустой массив —
 * запуск «ничего». `environment` необязателен; ключ переменной непустой и
 * уникальный (одноимённые пары в отображении JSON всё равно схлопнулись бы, и
 * пользователь бы этого не заметил).
 */
function parseAction(value: unknown): ProviderHookAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  const command = raw.command;
  if (!Array.isArray(command) || command.length === 0 || command.length > MAX_ARGV) {
    return undefined;
  }
  if (!command.every((item) => isCleanString(item) && item.length > 0)) return undefined;

  const action: ProviderHookAction = { command: command as string[] };

  if (raw.environment !== undefined) {
    if (!Array.isArray(raw.environment) || raw.environment.length > MAX_ENV_VARS) return undefined;
    const seen = new Set<string>();
    const environment: { key: string; value: string }[] = [];
    for (const item of raw.environment) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const pair = item as Record<string, unknown>;
      // Имя переменной окружения: непустое, без пробелов и без `=`.
      if (typeof pair.key !== 'string' || !/^[^\s=]+$/.test(pair.key)) return undefined;
      if (!isCleanString(pair.value)) return undefined;
      if (seen.has(pair.key)) return undefined;
      seen.add(pair.key);
      environment.push({ key: pair.key, value: pair.value });
    }
    if (environment.length > 0) action.environment = environment;
  }

  return action;
}

/** Разобрать массив действий. Пустой массив допустим — это «событие снято». */
function parseActions(value: unknown): ProviderHookAction[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) return undefined;
  const actions: ProviderHookAction[] = [];
  for (const item of value) {
    const action = parseAction(item);
    if (!action) return undefined;
    actions.push(action);
  }
  return actions;
}

/**
 * Разобрать черновик хуков из тела запроса. Схему zod в рантайме сервера
 * использовать нельзя (значение из contracts роняет node ESM) — проверяем руками.
 * Некорректное тело → `undefined` (маршрут ответит 400, файл не трогается).
 */
export function parseProviderHooksDraft(body: unknown): ProviderHooksDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;

  if (!Array.isArray(raw.fileEdited) || raw.fileEdited.length > MAX_PATTERNS) return undefined;

  const patterns = new Set<string>();
  const fileEdited: ProviderHookPatternGroup[] = [];
  for (const item of raw.fileEdited) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const group = item as Record<string, unknown>;
    // Шаблон — ключ объекта в файле: пустой или повторяющийся молча потерялся бы.
    if (!isCleanString(group.pattern) || !group.pattern.trim()) return undefined;
    if (patterns.has(group.pattern)) return undefined;
    patterns.add(group.pattern);

    const actions = parseActions(group.actions);
    // Шаблон без единого действия в файле выглядел бы как `"*.ts": []` — пустой
    // ключ без смысла. Такую группу не принимаем: её надо просто удалить.
    if (!actions || actions.length === 0) return undefined;
    fileEdited.push({ pattern: group.pattern, actions });
  }

  const sessionCompleted = parseActions(raw.sessionCompleted);
  if (!sessionCompleted) return undefined;

  return { fileEdited, sessionCompleted };
}

// --- Чтение ------------------------------------------------------------------

/** Форма файла OpenCode: правится ТОЛЬКО ключ `experimental`, прочее — как есть. */
interface RawOpencodeConfig {
  experimental?: unknown;
  [key: string]: unknown;
}

/** Сводка раздела для клиента. Файл не разобран → `readOnly` (fail-closed). */
export function readProviderHooksInfo(target: ProviderHooksTarget): ProviderHooksInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    filePath: target.filePath,
  };

  const text = readTextFile(target.filePath);
  if (!text.trim()) {
    return {
      ...base,
      present: false,
      fileEdited: [],
      sessionCompleted: [],
      preservedEvents: [],
      preservedExperimental: [],
      readOnly: false,
    };
  }

  try {
    const config = parseProviderJsonObject<RawOpencodeConfig>(text);
    const state = readOpencodeHook(config.experimental);
    return {
      ...base,
      present: state.present,
      fileEdited: state.fileEdited,
      sessionCompleted: state.sessionCompleted,
      preservedEvents: state.preservedEvents,
      preservedExperimental: state.preservedExperimental,
      readOnly: false,
    };
  } catch (error) {
    return {
      ...base,
      present: false,
      fileEdited: [],
      sessionCompleted: [],
      preservedEvents: [],
      preservedExperimental: [],
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// --- Запись ------------------------------------------------------------------

/**
 * Проекция «всё, кроме ключа `experimental.hook`». По ней результат сверяется с
 * оригиналом: изменился любой чужой ключ файла (`$schema`, `model`, `mcp`,
 * `permission`, `plugin`, …) либо любой чужой ключ внутри `experimental` —
 * запись отменяется. Ключи сортируются рекурсивно (`stableJson`).
 */
function otherKeysProjection(config: RawOpencodeConfig): string {
  const rest: Record<string, unknown> = { ...config };

  const experimental = config.experimental;
  if (experimental && typeof experimental === 'object' && !Array.isArray(experimental)) {
    const experimentalRest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(experimental as Record<string, unknown>)) {
      if (key === 'hook') continue;
      experimentalRest[key] = value;
    }
    // Внутри `hook` панель ведёт только два события — остальные тоже чужие.
    const hook = (experimental as Record<string, unknown>).hook;
    if (hook && typeof hook === 'object' && !Array.isArray(hook)) {
      const hookRest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(hook as Record<string, unknown>)) {
        if (key === 'file_edited' || key === 'session_completed') continue;
        hookRest[key] = value;
      }
      if (Object.keys(hookRest).length > 0) experimentalRest.hook = hookRest;
    }
    if (Object.keys(experimentalRest).length > 0) rest.experimental = experimentalRest;
    else delete rest.experimental;
  }

  return stableJson(rest);
}

/** Действия черновика в форму адаптера (типы совпадают структурно, копируем явно). */
function toLibActions(actions: ProviderHookAction[]): OpencodeHookAction[] {
  return actions.map((action) => ({
    command: [...action.command],
    ...(action.environment?.length
      ? { environment: action.environment.map((pair) => ({ ...pair })) }
      : {}),
  }));
}

function toLibDraft(draft: ProviderHooksDraft): OpencodeHookDraft {
  const fileEdited: OpencodeHookPatternGroup[] = draft.fileEdited.map((group) => ({
    pattern: group.pattern,
    actions: toLibActions(group.actions),
  }));
  return { fileEdited, sessionCompleted: toLibActions(draft.sessionCompleted) };
}

/**
 * Записать хуки, поменяв ТОЛЬКО ключ `experimental.hook`.
 *
 * Событие из черновика перезаписывается целиком; пустое событие УДАЛЯЕТСЯ;
 * событие, форму которого панель не поняла, не трогается вовсе (черновик,
 * который его называет, → 422). Пустой `hook` удаляет ключ, пустой
 * `experimental` — ключ `experimental`; `{}` в файле не появляется.
 * Нет файла → создаётся только с ключом `experimental`.
 */
export function saveProviderHooks(
  target: ProviderHooksTarget,
  draft: ProviderHooksDraft,
  backupDir: string | undefined,
): string | undefined {
  const text = readTextFile(target.filePath);
  const original: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};

  const libDraft = toLibDraft(draft);
  const experimental = applyOpencodeHook(config.experimental, libDraft);
  if (experimental) config.experimental = experimental;
  else delete config.experimental;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, оба события совпали с намерением, а все
  // прочие ключи файла, `experimental` и незнакомые события целы.
  const parsed = parseProviderJsonObject<RawOpencodeConfig>(next);
  const check = readOpencodeHook(parsed.experimental);
  if (stableJson(check.fileEdited) !== stableJson(libDraft.fileEdited)) {
    throw new UnrecognizedFormatError();
  }
  if (stableJson(check.sessionCompleted) !== stableJson(libDraft.sessionCompleted)) {
    throw new UnrecognizedFormatError();
  }
  if (otherKeysProjection(original) !== otherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm по умолчанию: файл пересобран из JSON.stringify (LF, без BOM),
  // поэтому форму пользовательского файла (BOM/CRLF) возвращает safe-io.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
