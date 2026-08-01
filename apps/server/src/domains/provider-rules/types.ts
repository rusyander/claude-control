import type {
  AppSettings,
  ProviderRulesFormat,
  ProviderRulesScope,
} from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
export interface ProviderRulesSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + каталог правил. */
export interface ProviderRulesTarget {
  provider: ConfigProvider;
  format: ProviderRulesFormat;
  scope: ProviderRulesScope;
  /** Абсолютный путь каталога правил (`~/.cursor/rules`). */
  rulesDir: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
}
