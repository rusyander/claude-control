import type {
  AppSettings,
  ProviderHooksFormat,
  ProviderHooksInfo,
  ProviderHooksScope,
  ProviderHooksShape,
} from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
export interface ProviderHooksSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/**
 * Формат хранилища хуков и форма раздела (два события OpenCode или плоский список
 * правил у Qwen и Kimi) описаны в контракте
 * (`packages/contracts/src/provider-hooks.ts`) — сервер их переэкспортирует, чтобы
 * не держать вторую копию.
 */
export type { ProviderHooksFormat, ProviderHooksShape };

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

/** Форма файла OpenCode: правится ТОЛЬКО ключ `experimental`, прочее — как есть. */
export interface RawOpencodeConfig {
  experimental?: unknown;
  [key: string]: unknown;
}

/** Форма файла Qwen: правится ТОЛЬКО ключ `hooks`, прочее — как есть. */
export interface RawQwenSettings {
  hooks?: unknown;
  disableAllHooks?: unknown;
  [key: string]: unknown;
}

/** Общая часть сводки, одинаковая для обеих моделей. */
export type HooksInfoBase = Pick<
  ProviderHooksInfo,
  'providerId' | 'providerName' | 'format' | 'shape' | 'scope' | 'filePath'
> &
  Partial<Pick<ProviderHooksInfo, 'writeDisabledReason'>>;

/** Границы и словарь событий формата — из адаптеров, а не из головы. */
export interface RulesMeta {
  events: { name: string; supportsMatcher: boolean }[];
  timeoutUnit: 'ms' | 's';
  timeoutMin: number;
  timeoutMax: number;
  timeoutDefault: number;
}
