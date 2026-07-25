import type {
  AppSettings,
  ProviderHookAction,
  ProviderHookPatternGroup,
  ProviderHookRule,
  ProviderHookRulesDraft,
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
import {
  QWEN_HOOK_EVENTS,
  QWEN_TIMEOUT_DEFAULT,
  QWEN_TIMEOUT_MAX,
  QWEN_TIMEOUT_MIN,
  applyQwenHooks,
  readQwenHooks,
} from '../lib/qwen-hook.ts';
import {
  KIMI_HOOK_EVENTS,
  KIMI_TIMEOUT_DEFAULT,
  KIMI_TIMEOUT_MAX,
  KIMI_TIMEOUT_MIN,
  readKimiHooks,
  writeKimiHooks,
} from '../lib/kimi-hook.ts';

/**
 * Раздел «Хуки» у НЕ-Claude провайдера (OPENCODE-3).
 *
 * У Claude хуки — свой богатый раздел (`domains/hooks.ts`, маршруты `/api/hooks`,
 * события `PreToolUse`/`PostToolUse`, матчеры, shell-команды). Он НЕ МЕНЯЕТСЯ:
 * модель у OpenCode принципиально другая, и мешать их в одном домене нельзя.
 *
 * У раздела ДВЕ ФОРМЫ, и выбирает их формат хранилища (`hooksShapeOf`):
 *
 *  - `opencode-events` — ключ `experimental.hook` в `opencode.json` (глобальном и
 *    проектном): ровно два задокументированных события (`file_edited`,
 *    `session_completed`), действия-argv. Разбор — `lib/opencode-hook.ts`.
 *    С 25 июля 2026 ТОЛЬКО ЧТЕНИЕ: ключ исчез из документации и схемы OpenCode
 *    (`writeDisabledReason` в каталоге), писать его — гадание;
 *  - `event-rules` — плоский список правил «событие + матчер + команда +
 *    таймаут»: у Qwen это ключ корня `hooks` в `settings.json`
 *    (`lib/qwen-hook.ts`, таймаут в миллисекундах), у Kimi — массив таблиц
 *    `[[hooks]]` в `config.toml` (`lib/kimi-hook.ts`, таймаут в секундах).
 *    Событие, форму которого панель не поняла, сохраняется целиком и не
 *    редактируется (у Kimi это переводит в чтение весь раздел: плоский массив
 *    нельзя переписать частично, не потеряв чужое).
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
export type ProviderHooksFormat = 'opencode-json' | 'qwen-json' | 'kimi-toml';

/** Форма раздела: два события OpenCode или плоский список правил (Qwen, Kimi). */
export type ProviderHooksShape = 'opencode-events' | 'event-rules';

/** Какой редактор у формата. Один источник правды — здесь. */
export function hooksShapeOf(format: ProviderHooksFormat): ProviderHooksShape {
  return format === 'opencode-json' ? 'opencode-events' : 'event-rules';
}

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderHooksTarget {
  provider: ConfigProvider;
  format: ProviderHooksFormat;
  scope: ProviderHooksScope;
  filePath: string;
  /**
   * Ключ снят с записи (исчез из документации и схемы CLI) — раздел только для
   * чтения. Берётся из каталога, а не решается здесь: catalog.ts — источник
   * правды о чужих форматах.
   */
  writeDisabledReason?: string;
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
    ...(provider.hooksConfig.writeDisabledReason
      ? { writeDisabledReason: provider.hooksConfig.writeDisabledReason }
      : {}),
  };
}

/**
 * Ключ снят с записи: раздел читается, но не пишется. Отдельный класс, а не
 * `UnrecognizedFormatError`, — причина другая (файл в полном порядке), и ответ
 * маршрута обязан объяснять именно её.
 */
export class WriteDisabledError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'WriteDisabledError';
    this.reason = reason;
  }
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

/**
 * Пустые поля ОБЕИХ моделей: сводка всегда одной формы, лишнее — пустое.
 * Функция, а не константа: массивы обязаны быть свежими и изменяемыми.
 */
function emptySections(): Pick<
  ProviderHooksInfo,
  | 'fileEdited'
  | 'sessionCompleted'
  | 'preservedEvents'
  | 'preservedExperimental'
  | 'rules'
  | 'preservedRules'
  | 'events'
> {
  return {
    fileEdited: [],
    sessionCompleted: [],
    preservedEvents: [],
    preservedExperimental: [],
    rules: [],
    preservedRules: [],
    events: [],
  };
}

// --- Модель «правила на событие» (Qwen, Kimi) --------------------------------

/** Общая часть сводки, одинаковая для обеих моделей. */
type HooksInfoBase = Pick<
  ProviderHooksInfo,
  'providerId' | 'providerName' | 'format' | 'shape' | 'scope' | 'filePath'
> &
  Partial<Pick<ProviderHooksInfo, 'writeDisabledReason'>>;

/** Границы и словарь событий формата — из адаптеров, а не из головы. */
interface RulesMeta {
  events: { name: string; supportsMatcher: boolean }[];
  timeoutUnit: 'ms' | 's';
  timeoutMin: number;
  timeoutMax: number;
  timeoutDefault: number;
}

function rulesMeta(format: ProviderHooksFormat): RulesMeta {
  if (format === 'kimi-toml') {
    return {
      // У Kimi матчер поддерживают все события: «регулярное выражение для
      // фильтрации целей события; без него совпадает со всеми».
      events: KIMI_HOOK_EVENTS.map((name) => ({ name, supportsMatcher: true })),
      timeoutUnit: 's',
      timeoutMin: KIMI_TIMEOUT_MIN,
      timeoutMax: KIMI_TIMEOUT_MAX,
      timeoutDefault: KIMI_TIMEOUT_DEFAULT,
    };
  }
  return {
    events: QWEN_HOOK_EVENTS.map((event) => ({ ...event })),
    timeoutUnit: 'ms',
    timeoutMin: QWEN_TIMEOUT_MIN,
    timeoutMax: QWEN_TIMEOUT_MAX,
    timeoutDefault: QWEN_TIMEOUT_DEFAULT,
  };
}

/** Форма файла Qwen: правится ТОЛЬКО ключ `hooks`, прочее — как есть. */
interface RawQwenSettings {
  hooks?: unknown;
  disableAllHooks?: unknown;
  [key: string]: unknown;
}

/**
 * Сводка раздела для модели `event-rules`. Файл не разобран → раздел только для
 * чтения (fail-closed), словарь событий отдаётся всё равно: он нужен интерфейсу,
 * чтобы объяснить, что вообще бывает.
 */
function readRulesInfo(target: ProviderHooksTarget, base: HooksInfoBase): ProviderHooksInfo {
  const meta = rulesMeta(target.format);
  const locked = Boolean(target.writeDisabledReason);
  const shell = {
    ...base,
    ...emptySections(),
    events: meta.events,
    timeoutUnit: meta.timeoutUnit,
    timeoutMin: meta.timeoutMin,
    timeoutMax: meta.timeoutMax,
    timeoutDefault: meta.timeoutDefault,
  };

  const text = readTextFile(target.filePath);
  if (!text.trim()) return { ...shell, present: false, readOnly: locked };

  try {
    if (target.format === 'kimi-toml') {
      const rules = readKimiHooks(text);
      // `present` здесь — «правила в файле есть»: отличить пустой регион
      // `[[hooks]]` от его отсутствия TOML не даёт, да это и одно и то же.
      return { ...shell, present: rules.length > 0, rules, readOnly: locked };
    }

    const config = parseProviderJsonObject<RawQwenSettings>(text);
    const state = readQwenHooks(config.hooks);
    return {
      ...shell,
      present: state.present,
      rules: state.rules,
      preservedRules: state.preservedEvents,
      // Рубильник CLI: панель его не пишет, но молчать о нём нельзя — с ним не
      // сработает ни одно правило раздела.
      ...(config.disableAllHooks === true ? { disableAll: true } : {}),
      readOnly: locked,
    };
  } catch (error) {
    return {
      ...shell,
      present: false,
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Максимум правил в черновике — та же защита от мусора, что у шаблонов. */
const MAX_RULES = 200;

/**
 * Разобрать черновик модели `event-rules`. Проверяется всё, что задокументировано
 * у CLI: событие из закрытого списка, матчер только там, где он поддержан,
 * непустая однострочная команда, целый таймаут в границах формата.
 */
export function parseProviderHookRulesDraft(
  body: unknown,
  target: ProviderHooksTarget,
): ProviderHookRulesDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;
  if (!Array.isArray(raw.rules) || raw.rules.length > MAX_RULES) return undefined;

  const meta = rulesMeta(target.format);
  const events = new Map(meta.events.map((event) => [event.name, event]));

  const rules: ProviderHookRule[] = [];
  for (const item of raw.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const entry = item as Record<string, unknown>;

    if (typeof entry.event !== 'string') return undefined;
    const event = events.get(entry.event);
    if (!event) return undefined;

    if (!isCleanString(entry.command) || !entry.command.trim()) return undefined;

    const rule: ProviderHookRule = { event: entry.event, command: entry.command };

    if (entry.matcher !== undefined && entry.matcher !== '') {
      // Матчер там, где событие его не поддерживает, CLI молча проигнорирует —
      // а пользователь будет уверен, что фильтр работает. Отказываем.
      if (!event.supportsMatcher) return undefined;
      if (!isCleanString(entry.matcher) || !entry.matcher.trim()) return undefined;
      rule.matcher = entry.matcher;
    }

    if (entry.timeout !== undefined) {
      const timeout = entry.timeout;
      if (typeof timeout !== 'number' || !Number.isInteger(timeout)) return undefined;
      if (timeout < meta.timeoutMin || timeout > meta.timeoutMax) return undefined;
      rule.timeout = timeout;
    }

    rules.push(rule);
  }

  return { rules };
}

/**
 * Записать правила модели `event-rules`.
 *
 * Qwen — ключ КОРНЯ `hooks` в `settings.json`: правится только он, события,
 * форму которых панель не поняла, сохраняются целиком. Kimi — регион таблиц
 * `[[hooks]]` в `config.toml`: хирургическая замена, всё вне региона байт-в-байт.
 * Пустой список удаляет ключ (регион), а не пишет пустышку.
 */
export function saveProviderHookRules(
  target: ProviderHooksTarget,
  draft: ProviderHookRulesDraft,
  backupDir: string | undefined,
): string | undefined {
  if (target.writeDisabledReason) throw new WriteDisabledError(target.writeDisabledReason);

  const text = readTextFile(target.filePath);

  if (target.format === 'kimi-toml') {
    const next = writeKimiHooks(text, draft.rules);
    return writeTextFile(target.filePath, next, {
      backupDir,
      backupName: backupNameOf(target),
    });
  }

  const original: RawQwenSettings = text.trim()
    ? parseProviderJsonObject<RawQwenSettings>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawQwenSettings = text.trim() ? parseProviderJsonObject<RawQwenSettings>(text) : {};

  const hooks = applyQwenHooks(config.hooks, draft.rules);
  if (hooks) config.hooks = hooks;
  else delete config.hooks;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, правила совпали с намерением, чужие
  // события внутри `hooks` целы, все прочие ключи файла целы.
  const parsed = parseProviderJsonObject<RawQwenSettings>(next);
  const check = readQwenHooks(parsed.hooks);
  if (stableJson(check.rules) !== stableJson(draft.rules)) throw new UnrecognizedFormatError();
  const before = readQwenHooks(original.hooks);
  if (stableJson(check.preservedEvents) !== stableJson(before.preservedEvents)) {
    throw new UnrecognizedFormatError();
  }
  if (qwenOtherKeysProjection(original) !== qwenOtherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}

/** Проекция «всё, кроме ключа `hooks`»: по ней сверяется неизменность чужого. */
function qwenOtherKeysProjection(config: RawQwenSettings): string {
  const rest: Record<string, unknown> = { ...config };
  delete rest.hooks;
  return stableJson(rest);
}

/** Сводка раздела для клиента. Файл не разобран → `readOnly` (fail-closed). */
export function readProviderHooksInfo(target: ProviderHooksTarget): ProviderHooksInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    shape: hooksShapeOf(target.format),
    scope: target.scope,
    filePath: target.filePath,
    ...(target.writeDisabledReason ? { writeDisabledReason: target.writeDisabledReason } : {}),
  };

  if (target.format !== 'opencode-json') return readRulesInfo(target, base);

  // Ключ снят с записи — раздел читается, но не пишется. Интерфейсу хватает
  // одного признака `readOnly`, чтобы запереть форму; причину он берёт из
  // `writeDisabledReason` — ошибкой файла это не является, `error` пуст.
  const locked = Boolean(target.writeDisabledReason);

  const text = readTextFile(target.filePath);
  if (!text.trim()) {
    return { ...base, ...emptySections(), present: false, readOnly: locked };
  }

  try {
    const config = parseProviderJsonObject<RawOpencodeConfig>(text);
    const state = readOpencodeHook(config.experimental);
    return {
      ...base,
      ...emptySections(),
      present: state.present,
      fileEdited: state.fileEdited,
      sessionCompleted: state.sessionCompleted,
      preservedEvents: state.preservedEvents,
      preservedExperimental: state.preservedExperimental,
      readOnly: locked,
    };
  } catch (error) {
    return {
      ...base,
      ...emptySections(),
      present: false,
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
  // Ключ снят с записи — отказ ДО чтения файла: писать в чужой конфиг ключ,
  // которого нет ни в документации CLI, ни в его схеме, панель не станет.
  if (target.writeDisabledReason) throw new WriteDisabledError(target.writeDisabledReason);
  // Писатель здесь ровно один — OpenCode. Цель другого формата сюда попасть не
  // должна; попала — это ошибка вызывающего, а не повод переписать чужой файл.
  if (target.format !== 'opencode-json') throw new UnrecognizedFormatError();

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
