import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AppSettings,
  CodexApprovalPolicy,
  CodexPermissionDraft,
  CodexSandboxMode,
  GeminiApprovalMode,
  GeminiPermissionDraft,
  OpencodePermissionDraft,
  OpencodePermissionEntry,
  OpencodePermissionLevel,
  OpencodePermissionTool,
  ContinuePermissionDraft,
  CursorPermissionDraft,
  CursorPermissionKind,
  GoosePermissionDraft,
  KimiPermissionDraft,
  ProviderPermissionDraft,
  ProviderPermissionInfo,
  QwenApprovalMode,
  QwenPermissionDraft,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { providerBackupName, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  upsertCodexRootScalar,
} from '../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../lib/provider-json.ts';
import {
  CONTINUE_PERMISSION_KEYS,
  hasContinuePermissionKeys,
  readContinuePermissions,
  writeContinuePermissions,
} from '../lib/continue-yaml.ts';
import {
  GOOSE_DEFAULT_MODE,
  GOOSE_MODES,
  readGooseMode,
  writeGooseMode,
  type GooseMode,
} from '../lib/goose-yaml.ts';
import {
  KIMI_DECISIONS,
  KIMI_DEFAULT_MODE,
  KIMI_MODES,
  readKimiMode,
  readKimiRules,
  writeKimiPermissions,
  type KimiDecision,
  type KimiMode,
  type KimiPermissionRule,
} from '../lib/kimi-toml.ts';
import {
  OPENCODE_PATTERN_TOOLS,
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  applyOpencodePermission,
  readOpencodePermission,
  supportsPatternMap,
  type OpencodePreservedEntry,
  type OpencodeToolPermission,
} from '../lib/opencode-permission.ts';

/**
 * Универсальный раздел прав/аппрувов — для провайдеров Codex (TOML), Gemini
 * (settings.json) и OpenCode (opencode.json). Claude сюда НЕ попадает: его права
 * живут в settings.json (permissions allow/deny/ask) и обслуживаются собственными
 * богатыми роутами — тот раздел не трогаем.
 * Роутинг «claude → свои роуты, прочие → /api/provider-permissions» делает клиент
 * по активному провайдеру.
 *
 * БЕЗОПАСНОСТЬ ПРЕЖДЕ ВСЕГО.
 *
 * CODEX (`toml`) — два СКАЛЯРНЫХ ключа КОРНЯ `~/.codex/config.toml`:
 * `approval_policy` и `sandbox_mode`. ЗАПИСЬ ХИРУРГИЧЕСКАЯ
 * (`upsertCodexRootScalar` для каждого ключа): правится только корневой скаляр —
 * одноимённые ключи ВНУТРИ таблиц (`[profiles.x]` и т.п.) НЕ тронуты; таблицы,
 * комментарии, прочие корневые ключи — БАЙТ-В-БАЙТ.
 *
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
 *
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
 *
 * CONTINUE (`continue-yaml`) — ОТДЕЛЬНЫЙ файл `~/.continue/permissions.yaml`, а
 * не секция общего конфига. Модель прав у Continue проще всех: НИКАКОГО режима,
 * ровно три списка верхнего уровня — `allow` (выполнять сразу), `ask`
 * (спрашивать), `exclude` (спрятать инструмент от агента). Элементы —
 * задокументированные строки-правила (`Read(*)`, `Bash`, инструмент с шаблоном
 * путей). Правка идёт Document API пакета `yaml`: комментарии и прочие ключи
 * файла целы, пустой список УДАЛЯЕТ свой ключ, а не пишет `[]`.
 *
 * GOOSE (`goose-yaml`) — ОДИН скалярный ключ КОРНЯ `config.yaml`: `GOOSE_MODE`
 * (`auto` — выполнять всё без вопросов, `approve` — только по заданным
 * разрешениям, `smart_approve` — авто-одобрение безопасных вызовов, `chat` — без
 * запуска инструментов вовсе). Ни списков, ни второго ключа у этой модели нет.
 * Пофайловые разрешения инструментов Goose держит в `permission.yaml` — панель
 * его НЕ ведёт (формат не разбирался), правится ровно `GOOSE_MODE`, соседние
 * ключи и расширения того же файла целы.
 *
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
 *
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
 *
 * ВАЛИДАЦИЯ ENUM ДО ЗАПИСИ: значение вне разрешённого набора отклоняется на разборе
 * черновика (маршрут отвечает 400) — в файл не пишется.
 *
 * FAIL-CLOSED: файл не парсится / итог не репарсится / итог ≠ намерению → НЕ
 * пишем, бросаем `UnrecognizedFormatError` (раздел только для чтения; маршрут
 * 422). Никогда не пишем наугад.
 */

// Переэкспорт для роутов/тестов; класс один и тот же (из lib) — `instanceof` цел.
export { UnrecognizedFormatError };

/** Разрешённые значения (дублируют contracts значением — в рантайм сервера contracts тянется лишь как тип). */
const APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = ['untrusted', 'on-request', 'never'];
const SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/** Разрешённые в settings.json режимы аппрувов Gemini. `yolo` сюда НЕ входит. */
export const GEMINI_APPROVAL_MODES: readonly GeminiApprovalMode[] = [
  'default',
  'auto_edit',
  'plan',
];

/**
 * Режимы, которые Gemini понимает ТОЛЬКО как флаг командной строки: в
 * settings.json они вызывают ошибку enum при старте CLI. Панель их не пишет.
 */
export const GEMINI_CLI_ONLY_APPROVAL_MODES: readonly string[] = ['yolo'];

/** Дефолты Codex (когда ключ отсутствует). НЕ записываются молча — только по действию пользователя. */
const DEFAULT_APPROVAL: CodexApprovalPolicy = 'on-request';
const DEFAULT_SANDBOX: CodexSandboxMode = 'workspace-write';

/** Дефолт Gemini: спрашивать подтверждение перед каждым вызовом инструмента. */
const DEFAULT_GEMINI_APPROVAL: GeminiApprovalMode = 'default';

/**
 * Режимы аппрувов Qwen Code, допустимые в `settings.json` (`tools.approvalMode`).
 * `yolo` входит СОЗНАТЕЛЬНО: у Qwen он задокументирован как значение файла (в
 * отличие от Gemini, где это только флаг командной строки).
 */
export const QWEN_APPROVAL_MODES: readonly QwenApprovalMode[] = [
  'default',
  'plan',
  'auto-edit',
  'auto',
  'yolo',
];

/** Дефолт Qwen: спрашивать подтверждение перед каждым действием. */
const DEFAULT_QWEN_APPROVAL: QwenApprovalMode = 'default';

interface ProviderPermissionsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Формат файла прав, поддержанный универсальным разделом. */
export type ProviderPermissionsFormat =
  | 'toml'
  | 'gemini-json'
  | 'qwen-json'
  | 'opencode-json'
  | 'continue-yaml'
  | 'goose-yaml'
  | 'kimi-toml'
  | 'cursor-json';

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderPermissionsTarget {
  provider: ConfigProvider;
  format: ProviderPermissionsFormat;
  filePath: string;
  cliDetected: boolean;
  /**
   * Имя резервной копии. По умолчанию — `<id>-<basename>` (глобальный файл
   * провайдера). Проектный уровень передаёт своё (`<id>-project-<basename>`),
   * чтобы копии проекта не делили ротацию с копиями глобального конфига.
   */
  backupName?: string;
}

/** Имя копии для этой цели: своё, если задано, иначе стандартное `<id>-<basename>`. */
function backupNameOf(target: ProviderPermissionsTarget): string {
  return target.backupName ?? providerBackupName(target.provider.id, target.filePath);
}

/**
 * Цель универсального раздела прав активного провайдера — или `undefined`, если он
 * им не поддержан (маршрут ответит 4xx). Поддержан, только когда `permissions` =
 * `ready` И задан `permissionsConfig` (Codex, Gemini, OpenCode). Claude сюда не
 * попадает (у него нет `permissionsConfig`) — он на своих роутах. Fail-closed.
 */
export function resolveProviderPermissionsTarget(
  store: ProviderPermissionsSettingsSource,
): ProviderPermissionsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.permissions !== 'ready' || !provider.permissionsConfig)
    return undefined;

  const filePath = provider.permissionsConfig.path(store.getSettings().claudeDirOverride);
  return {
    provider,
    format: provider.permissionsConfig.format,
    filePath,
    cliDetected: existsSync(dirname(filePath)),
  };
}

// --- Разбор черновика (валидация enum на стороне сервера) --------------------

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

function parseCodexDraft(rec: Record<string, unknown>): CodexPermissionDraft | undefined {
  const approvalPolicy = rec.approvalPolicy;
  const sandboxMode = rec.sandboxMode;
  if (
    typeof approvalPolicy !== 'string' ||
    !APPROVAL_POLICIES.includes(approvalPolicy as CodexApprovalPolicy)
  )
    return undefined;
  if (typeof sandboxMode !== 'string' || !SANDBOX_MODES.includes(sandboxMode as CodexSandboxMode))
    return undefined;
  return {
    approvalPolicy: approvalPolicy as CodexApprovalPolicy,
    sandboxMode: sandboxMode as CodexSandboxMode,
  };
}

/**
 * Список имён инструментов: массив непустых строк. Пробелы по краям срезаются,
 * повторы схлопываются (порядок первого вхождения сохраняется). Не массив или
 * элемент не строка → `undefined` (черновик целиком отклоняется).
 */
function parseToolList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return undefined;
    const name = item.trim();
    if (!name) continue;
    if (!list.includes(name)) list.push(name);
  }
  return list;
}

function parseGeminiDraft(rec: Record<string, unknown>): GeminiPermissionDraft | undefined {
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
 * Разобрать черновик прав Qwen Code: режим аппрувов + три списка правил. Правила
 * — непрозрачные строки (панель их синтаксис не толкует, только хранит), поэтому
 * проверяем ровно форму: массив непустых строк без повторов (`parseToolList`).
 */
function parseQwenDraft(rec: Record<string, unknown>): QwenPermissionDraft | undefined {
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
 * Разобрать черновик прав Continue: три списка правил и НИКАКОГО режима. Правила
 * — непрозрачные строки (панель их синтаксис не толкует, только хранит), поэтому
 * проверяем ровно форму: массив непустых строк без повторов (`parseToolList`).
 */
function parseContinueDraft(rec: Record<string, unknown>): ContinuePermissionDraft | undefined {
  const allow = parseToolList(rec.allow);
  const ask = parseToolList(rec.ask);
  const exclude = parseToolList(rec.exclude);
  if (!allow || !ask || !exclude) return undefined;
  return { allow, ask, exclude };
}

/**
 * Разобрать черновик прав Cursor: ровно два списка правил. Формы правил
 * (`Shell(...)`, `Read(...)`, …) панель НЕ проверяет: документация допускает
 * шаблоны и синтаксис `команда:аргументы`, и отсев «непонятного» вырезал бы
 * рабочие правила пользователя. Проверяется ровно то, что можно проверить не
 * гадая, — что это непустые однострочные строки (см. `parseToolList`).
 */
function parseCursorDraft(rec: Record<string, unknown>): CursorPermissionDraft | undefined {
  const allow = parseToolList(rec.allow);
  const deny = parseToolList(rec.deny);
  if (!allow || !deny) return undefined;
  return { allow, deny };
}

/**
 * Разобрать черновик прав Goose: ОДИН ключ `mode` из задокументированного
 * набора (`auto`, `approve`, `smart_approve`, `chat`). Списков у Goose нет.
 */
function parseGooseDraft(rec: Record<string, unknown>): GoosePermissionDraft | undefined {
  const mode = rec.mode;
  if (typeof mode !== 'string' || !(GOOSE_MODES as readonly string[]).includes(mode)) {
    return undefined;
  }
  return { mode: mode as GooseMode };
}

/**
 * Разобрать черновик прав Kimi: режим `default_permission_mode` + ВЕСЬ список
 * правил. Правило — ровно два поля: `decision` из набора и непустой `pattern`
 * (синтаксис шаблона панель не толкует, только хранит). Порядок правил значим и
 * сохраняется как прислали; полный повтор (то же решение с тем же шаблоном)
 * отбрасывается — две одинаковые строки в файле пользы не несут.
 */
function parseKimiDraft(rec: Record<string, unknown>): KimiPermissionDraft | undefined {
  const mode = rec.mode;
  if (typeof mode !== 'string' || !(KIMI_MODES as readonly string[]).includes(mode)) {
    return undefined;
  }
  if (!Array.isArray(rec.rules)) return undefined;

  const rules: KimiPermissionRule[] = [];
  const seen = new Set<string>();
  for (const item of rec.rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const { decision, pattern } = item as Record<string, unknown>;
    if (typeof decision !== 'string' || !(KIMI_DECISIONS as readonly string[]).includes(decision)) {
      return undefined;
    }
    if (typeof pattern !== 'string') return undefined;
    // Пустая строка — это пустая строка формы, а не ошибка: как в списках
    // Qwen/Continue, такую запись молча выбрасываем.
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    const key = `${decision}\u0000${trimmed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ decision: decision as KimiDecision, pattern: trimmed });
  }

  return { mode: mode as KimiMode, rules };
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
function parseOpencodeDraft(rec: Record<string, unknown>): OpencodePermissionDraft | undefined {
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

// --- Прочитанные значения ----------------------------------------------------

/** Значения прав Codex: два скалярных ключа корня config.toml. */
export interface CodexPermissionsValues {
  kind: 'codex';
  approvalPolicy: CodexApprovalPolicy;
  sandboxMode: CodexSandboxMode;
  /** Оба значения — дефолты (ключей нет в файле); дефолт не записан. */
  usingDefaults: boolean;
}

/** Значения прав Gemini: режим аппрувов + белый и чёрный списки инструментов. */
export interface GeminiPermissionsValues {
  kind: 'gemini';
  approvalMode: GeminiApprovalMode;
  coreTools: string[];
  excludeTools: string[];
  /** Ни один из трёх ключей не задан в файле; дефолт не записан. */
  usingDefaults: boolean;
}

/** Значения прав Qwen Code: режим аппрувов + три списка правил `permissions.*`. */
export interface QwenPermissionsValues {
  kind: 'qwen';
  approvalMode: QwenApprovalMode;
  allow: string[];
  ask: string[];
  deny: string[];
  /** Ни один из ведомых панелью ключей не задан в файле; дефолт не записан. */
  usingDefaults: boolean;
}

/** Значения прав Cursor: два списка внутри `permissions`, без режима. */
export interface CursorPermissionsValues {
  kind: 'cursor';
  allow: string[];
  deny: string[];
  /** Ключа `permissions` в файле нет; дефолты CLI не записаны. */
  usingDefaults: boolean;
}

/** Значения прав Continue: три списка `permissions.yaml`, без режима. */
export interface ContinuePermissionsValues {
  kind: 'continue';
  allow: string[];
  ask: string[];
  exclude: string[];
  /** Ни одного из трёх ключей в файле нет; дефолты CLI не записаны. */
  usingDefaults: boolean;
}

/** Значения прав OpenCode: ключ `permission` файла opencode.json. */
export interface OpencodePermissionsValues {
  kind: 'opencode';
  /** Заданные ограничения по инструментам (простой уровень либо карта шаблонов). */
  entries: OpencodeToolPermission[];
  /** Записи `permission`, которые панель не ведёт: сохраняются, только чтение. */
  preserved: OpencodePreservedEntry[];
  /** Ключ `permission` в файле отсутствует; дефолт CLI не записан. */
  usingDefaults: boolean;
}

/** Значения прав Goose: один режим `GOOSE_MODE` в корне config.yaml. */
export interface GoosePermissionsValues {
  kind: 'goose';
  mode: GooseMode;
  /** Ключа `GOOSE_MODE` в файле нет; дефолт CLI не записан. */
  usingDefaults: boolean;
}

/** Значения прав Kimi Code: режим корня + упорядоченные правила config.toml. */
export interface KimiPermissionsValues {
  kind: 'kimi';
  mode: KimiMode;
  rules: KimiPermissionRule[];
  /** Ни режима, ни правил в файле нет; дефолт CLI не записан. */
  usingDefaults: boolean;
}

export type ProviderPermissionsValues =
  | CodexPermissionsValues
  | GeminiPermissionsValues
  | QwenPermissionsValues
  | ContinuePermissionsValues
  | CursorPermissionsValues
  | GoosePermissionsValues
  | KimiPermissionsValues
  | OpencodePermissionsValues;

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
  if (target.format === 'goose-yaml') return readGoosePermissionsValues(text);
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

// --- Сводка раздела для клиента (одна на глобальный и проектный маршрут) ------

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

// --- Codex (TOML: ~/.codex/config.toml, скалярные ключи корня) ---------------

/**
 * Прочитать текущие значения обоих ключей КОРНЯ. Отсутствует ключ → дефолт Codex
 * (НЕ пишем его — только показываем). Значение вне enum сохраняется как есть на
 * чтение (интерфейс покажет фактическое состояние), но помечает раздел не как
 * usingDefaults. Непарсящийся файл → fail-closed (бросает).
 */
function readCodexPermissions(text: string): CodexPermissionsValues {
  if (!text.trim()) {
    return {
      kind: 'codex',
      approvalPolicy: DEFAULT_APPROVAL,
      sandboxMode: DEFAULT_SANDBOX,
      usingDefaults: true,
    };
  }
  const parsed = parseCodexToml(text);
  const rawApproval = parsed.approval_policy;
  const rawSandbox = parsed.sandbox_mode;

  const approvalPresent =
    typeof rawApproval === 'string' &&
    APPROVAL_POLICIES.includes(rawApproval as CodexApprovalPolicy);
  const sandboxPresent =
    typeof rawSandbox === 'string' && SANDBOX_MODES.includes(rawSandbox as CodexSandboxMode);

  return {
    kind: 'codex',
    approvalPolicy: approvalPresent ? (rawApproval as CodexApprovalPolicy) : DEFAULT_APPROVAL,
    sandboxMode: sandboxPresent ? (rawSandbox as CodexSandboxMode) : DEFAULT_SANDBOX,
    usingDefaults: rawApproval === undefined && rawSandbox === undefined,
  };
}

/**
 * Записать оба скалярных ключа КОРНЯ через `upsertCodexRootScalar`. Правится только
 * корневой скаляр — одноимённые ключи внутри таблиц (`[profiles.x]`) НЕ тронуты; всё
 * прочее байт-в-байт. Итог репарсится и сверяется с намерением — расхождение →
 * fail-closed (не пишем). Нет файла → создаётся только с этими двумя ключами.
 */
function saveCodexPermissions(
  target: ProviderPermissionsTarget,
  draft: CodexPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const exists = existsSync(target.filePath);
  const original = exists ? readFileSync(target.filePath, 'utf8') : '';

  // Оригинал обязан парситься (иначе не знаем структуру и границу корня) — fail-closed.
  if (original.trim()) parseCodexToml(original);

  let next = original.trim() ? original : '';
  next = upsertCodexRootScalar(next, 'approval_policy', draft.approvalPolicy);
  next = upsertCodexRootScalar(next, 'sandbox_mode', draft.sandboxMode);

  // Верификация: итог обязан валидно репарситься, а корневые значения — точно
  // совпадать с намерением. Иначе surgery что-то испортила → не пишем.
  const reparsed = parseCodexToml(next);
  if (
    reparsed.approval_policy !== draft.approvalPolicy ||
    reparsed.sandbox_mode !== draft.sandboxMode
  ) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm:false — правится одна строка исходного текста (CRLF учтён в
  // upsertCodexRootScalar, BOM исходника цел); всё прочее байт-в-байт.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    preserveForm: false,
  });
}

// --- Gemini (settings.json: general.defaultApprovalMode + coreTools/excludeTools) ---

interface RawGeminiSettings {
  general?: Record<string, unknown>;
  coreTools?: unknown;
  excludeTools?: unknown;
  [key: string]: unknown;
}

/** Секция `general` как объект. Не объект (строка/массив/число) → fail-closed. */
function geminiGeneral(config: RawGeminiSettings): Record<string, unknown> | undefined {
  const general = config.general;
  if (general === undefined || general === null) return undefined;
  if (typeof general !== 'object' || Array.isArray(general)) throw new UnrecognizedFormatError();
  return general as Record<string, unknown>;
}

/** Список инструментов из файла. Не массив строк → fail-closed (форма не наша). */
function geminiToolList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new UnrecognizedFormatError();
  if (!value.every((item) => typeof item === 'string')) throw new UnrecognizedFormatError();
  return value as string[];
}

/**
 * Прочитать права Gemini. Отсутствующий режим → дефолт `default`. Режим вне
 * набора (например, вручную вписанный `yolo`) показываем как дефолт, но раздел
 * при этом НЕ считается «на дефолтах»: интерфейс подскажет, что значение в файле
 * панель не поддерживает и сохранение его заменит.
 */
function readGeminiPermissions(text: string): GeminiPermissionsValues {
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
  const rawMode = geminiGeneral(config)?.defaultApprovalMode;
  const coreTools = geminiToolList(config.coreTools);
  const excludeTools = geminiToolList(config.excludeTools);

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
 */
function geminiOtherKeysProjection(config: RawGeminiSettings): string {
  const rest: Record<string, unknown> = { ...config };
  delete rest.coreTools;
  delete rest.excludeTools;

  const general = rest.general;
  if (general && typeof general === 'object' && !Array.isArray(general)) {
    const generalRest: Record<string, unknown> = { ...(general as Record<string, unknown>) };
    delete generalRest.defaultApprovalMode;
    if (Object.keys(generalRest).length > 0) rest.general = generalRest;
    else delete rest.general;
  }

  // Ключи сортируем: сравниваем СОДЕРЖИМОЕ, а не порядок обхода.
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Записать права Gemini в settings.json, поменяв ТОЛЬКО три ключа. Пустой список
 * инструментов удаляет свой ключ (пустой `coreTools` означал бы «ничего нельзя»).
 * Нет файла → создаётся с одним `general.defaultApprovalMode`.
 */
function saveGeminiPermissions(
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

  const general = geminiGeneral(config) ?? {};
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

// --- Qwen Code (settings.json: tools.approvalMode + permissions.*) -----------

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

/** Секция файла как объект. Не объект (строка/массив/число) → fail-closed. */
function qwenSection(config: RawQwenSettings, key: string): Record<string, unknown> | undefined {
  const section = config[key];
  if (section === undefined || section === null) return undefined;
  if (typeof section !== 'object' || Array.isArray(section)) throw new UnrecognizedFormatError();
  return section as Record<string, unknown>;
}

/** Список правил из файла. Не массив строк → fail-closed (форма не наша). */
function qwenRuleList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new UnrecognizedFormatError();
  if (!value.every((item) => typeof item === 'string')) throw new UnrecognizedFormatError();
  return value as string[];
}

/**
 * Прочитать права Qwen Code. Отсутствующий режим → дефолт `default`. Режим вне
 * набора показываем как дефолт, но раздел при этом НЕ считается «на дефолтах»:
 * интерфейс подскажет, что значение из файла панель не поддерживает и сохранение
 * его заменит.
 */
function readQwenPermissions(text: string): QwenPermissionsValues {
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
  const rawMode = qwenSection(config, 'tools')?.approvalMode;
  const permissions = qwenSection(config, 'permissions');
  const allow = qwenRuleList(permissions?.allow);
  const ask = qwenRuleList(permissions?.ask);
  const deny = qwenRuleList(permissions?.deny);

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

  const strip = (key: string, managed: string[]): void => {
    const section = rest[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return;
    const sectionRest: Record<string, unknown> = { ...(section as Record<string, unknown>) };
    for (const name of managed) delete sectionRest[name];
    if (Object.keys(sectionRest).length > 0) rest[key] = sectionRest;
    else delete rest[key];
  };

  strip('tools', ['approvalMode']);
  strip('permissions', ['allow', 'ask', 'deny']);

  return stableJson(rest);
}

/**
 * Записать права Qwen Code в settings.json, поменяв ТОЛЬКО `tools.approvalMode` и
 * три списка внутри `permissions`. Пустой список удаляет свой ключ; пустые все
 * три — весь объект `permissions` (писать `{}` панель не станет). Нет файла →
 * создаётся с одним `tools.approvalMode`.
 */
function saveQwenPermissions(
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

  const tools = qwenSection(config, 'tools') ?? {};
  tools.approvalMode = draft.approvalMode;
  config.tools = tools;

  const permissions = qwenSection(config, 'permissions') ?? {};
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

// --- Continue (permissions.yaml: три списка allow/ask/exclude) ---------------

/**
 * Прочитать права Continue. Файла нет → дефолты CLI (чтение разрешено, запись
 * инструментов спрашивается) — их панель НЕ пишет, только показывает пустые
 * списки. Файл есть, но все три ключа отсутствуют → тоже «на дефолтах».
 */
function readContinuePermissionsValues(text: string): ContinuePermissionsValues {
  if (!text.trim()) {
    return { kind: 'continue', allow: [], ask: [], exclude: [], usingDefaults: true };
  }

  const lists = readContinuePermissions(text);
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
function saveContinuePermissions(
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

// --- Cursor (cli-config.json / cli.json: permissions.allow + permissions.deny) ---

/**
 * Задокументированные формы правил Cursor. Список идёт КЛИЕНТУ как подсказка и
 * НЕ используется как фильтр: панель правила не толкует (см. `parseCursorDraft`).
 */
const CURSOR_RULE_KINDS: readonly CursorPermissionKind[] = [
  'Shell',
  'Read',
  'Write',
  'WebFetch',
  'Mcp',
];

/**
 * Форма файла Cursor. Панель ведёт РОВНО два списка внутри `permissions`; всё
 * прочее (`version`, `editor`, любые будущие ключи CLI) — чужое и сохраняется.
 */
interface RawCursorConfig {
  permissions?: unknown;
  [key: string]: unknown;
}

/**
 * Прочитать права Cursor. Файла нет или он пуст → дефолты CLI (панель их НЕ
 * пишет, показывает пустые списки). Ключ `permissions` есть, но не объект, или
 * список не массив строк → fail-closed: форма не наша, править вслепую нельзя.
 */
function readCursorPermissions(text: string): CursorPermissionsValues {
  if (!text.trim()) return { kind: 'cursor', allow: [], deny: [], usingDefaults: true };

  const config = parseProviderJsonObject<RawCursorConfig>(text);
  const section = config.permissions;
  if (section === undefined || section === null) {
    return { kind: 'cursor', allow: [], deny: [], usingDefaults: true };
  }
  if (typeof section !== 'object' || Array.isArray(section)) throw new UnrecognizedFormatError();

  const permissions = section as Record<string, unknown>;
  // Разбор списка тот же, что у Qwen: не массив строк → форма чужая.
  const allow = qwenRuleList(permissions.allow);
  const deny = qwenRuleList(permissions.deny);

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
 * считались бы разными и запись падала бы на здоровом файле.
 */
function cursorOtherKeysProjection(config: RawCursorConfig): string {
  const rest: Record<string, unknown> = { ...config };
  const section = rest.permissions;
  if (section && typeof section === 'object' && !Array.isArray(section)) {
    const sectionRest: Record<string, unknown> = { ...(section as Record<string, unknown>) };
    delete sectionRest.allow;
    delete sectionRest.deny;
    if (Object.keys(sectionRest).length > 0) rest.permissions = sectionRest;
    else delete rest.permissions;
  } else if (section !== undefined) {
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
function saveCursorPermissions(
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

// --- Goose (config.yaml: скалярный ключ корня GOOSE_MODE) --------------------

/**
 * Прочитать режим Goose. Ключа нет → дефолт CLI (`auto`: именно в нём идут
 * неинтерактивные сессии), и панель его НЕ пишет. Значение вне набора показываем
 * дефолтом, но раздел НЕ считается «на дефолтах»: в файле что-то задано, и
 * пользователь должен это видеть.
 */
function readGoosePermissionsValues(text: string): GoosePermissionsValues {
  if (!text.trim()) return { kind: 'goose', mode: GOOSE_DEFAULT_MODE, usingDefaults: true };

  const raw = readGooseMode(text);
  if (raw === undefined) return { kind: 'goose', mode: GOOSE_DEFAULT_MODE, usingDefaults: true };
  const known = (GOOSE_MODES as readonly string[]).includes(raw);
  return {
    kind: 'goose',
    mode: known ? (raw as GooseMode) : GOOSE_DEFAULT_MODE,
    usingDefaults: false,
  };
}

/**
 * Записать `GOOSE_MODE`, сохранив расширения, прочие ключи и комментарии файла.
 * Контроль до записи: итог читается нашей же моделью и совпал с намерением.
 */
function saveGoosePermissions(
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

// --- Kimi Code (config.toml: default_permission_mode + [[permission.rules]]) --

/**
 * Прочитать права Kimi. Ни режима, ни правил → дефолт CLI (`manual`: без ключа
 * Kimi спрашивает подтверждение), и панель его НЕ пишет. Значение режима вне
 * набора показываем дефолтом, но «на дефолтах» раздел уже не считается: в файле
 * что-то задано. Чужая форма блока правил → fail-closed (бросает).
 */
function readKimiPermissionsValues(text: string): KimiPermissionsValues {
  if (!text.trim()) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }

  const raw = readKimiMode(text);
  const rules = readKimiRules(text);
  if (raw === undefined && rules.length === 0) {
    return { kind: 'kimi', mode: KIMI_DEFAULT_MODE, rules: [], usingDefaults: true };
  }
  const known = raw !== undefined && (KIMI_MODES as readonly string[]).includes(raw);
  return {
    kind: 'kimi',
    mode: known ? (raw as KimiMode) : KIMI_DEFAULT_MODE,
    rules,
    usingDefaults: false,
  };
}

/**
 * Записать режим и правила Kimi. Хирургия внутри `lib/kimi-toml.ts`: прочие
 * ключи `config.toml` (провайдеры, модели, хуки) остаются байт-в-байт. Контроль
 * до записи: итог читается нашей же моделью и совпал с намерением.
 */
function saveKimiPermissions(
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

// --- OpenCode (opencode.json: ключ `permission`) ------------------------------

/** Форма файла OpenCode: правится ТОЛЬКО ключ `permission`, прочее — как есть. */
interface RawOpencodeConfig {
  permission?: unknown;
  [key: string]: unknown;
}

/**
 * Прочитать права OpenCode. Нет файла или нет ключа `permission` → ограничений
 * нет (OpenCode ничего не ограничивает по умолчанию; дефолт панель НЕ пишет).
 * Файл не парсится или `permission` не объект → fail-closed (бросает).
 */
function readOpencodePermissions(text: string): OpencodePermissionsValues {
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
function saveOpencodePermissions(
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
