import type {
  AppSettings,
  CodexApprovalPolicy,
  CodexSandboxMode,
  GeminiApprovalMode,
  QwenApprovalMode,
} from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import type { GooseMode } from '../../lib/goose-yaml.ts';
import type { GooseToolPermissions } from '../../lib/goose-permission-file.ts';
import type { KimiMode, KimiPermissionRule } from '../../lib/kimi-toml.ts';
import type {
  OpencodePreservedEntry,
  OpencodeToolPermission,
} from '../../lib/opencode-permission.ts';

export interface ProviderPermissionsSettingsSource {
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
  /**
   * ТОЛЬКО ЧТЕНИЕ: файл пофайловых разрешений инструментов (Goose
   * `permission.yaml`). Задан — раздел показывает его содержимое и говорит, что
   * правится оно только через `goose configure`.
   */
  toolPermissionsPath?: string;
}

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
  /**
   * Пофайловые разрешения инструментов из соседнего `permission.yaml` — ТОЛЬКО
   * ПОКАЗ (формат не опубликован, панель его не пишет). Файла нет или он не
   * сходится с ожидаемой формой → `undefined`: показывать нечего.
   */
  toolPermissions?: GooseToolPermissions;
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
