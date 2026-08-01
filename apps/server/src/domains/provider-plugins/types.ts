import type { AppSettings, ProviderPluginsScope } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
export interface ProviderPluginsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + каталог файлов + конфиг npm-списка. */
export interface ProviderPluginsTarget {
  provider: ConfigProvider;
  format: 'opencode-plugins' | 'kimi-plugins';
  scope: ProviderPluginsScope;
  /** Абсолютный путь каталога плагинов (у Kimi — `plugins/managed`). */
  pluginsDir: string;
  /** Абсолютный путь конфигурации с массивом `plugin` — только у OpenCode. */
  configPath?: string;
  /** Абсолютный путь реестра `installed.json` — только у Kimi. */
  registryPath?: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
}

/** Форма файла OpenCode: правится ТОЛЬКО ключ `plugin`, прочее — как есть. */
export interface RawOpencodeConfig {
  plugin?: unknown;
  [key: string]: unknown;
}
