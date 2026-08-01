import type { AppSettings, UniversalMcpServer } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';
import type { SkippedMcpBlock } from './blocks.ts';

/** Источник настроек: провайдер и переопределение каталога конфигурации. */
export interface ProviderMcpSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Формат файла MCP-конфигурации, поддержанный универсальным разделом. */
export type ProviderMcpFormat = 'json' | 'toml' | 'opencode-json' | 'continue-yaml' | 'goose-yaml';

/** Разрешённая цель раздела: провайдер + формат + путь к файлу. */
export interface ProviderMcpTarget {
  provider: ConfigProvider;
  format: ProviderMcpFormat;
  filePath: string;
  cliDetected: boolean;
  /** Формат `json`: ключ адреса http-сервера при ЗАПИСИ (`httpUrl` по умолчанию). */
  jsonHttpUrlKey: 'httpUrl' | 'url';
  /**
   * Имя резервной копии. По умолчанию — `<id>-<basename>` (глобальный файл
   * провайдера). Проектный уровень (COMMON-2) передаёт своё
   * (`<id>-project-<basename>`), чтобы копии проекта не делили ротацию с копиями
   * глобального конфига того же провайдера.
   */
  backupName?: string;
  /**
   * Каталог файлов-блоков (Continue): их серверы показываются вместе с
   * серверами основного файла, а правка идёт в тот файл, где запись лежит.
   * Не задан → блоков у провайдера нет (все прочие форматы).
   */
  blockDir?: string;
}

/** Раздел целиком: серверы основного файла + файлов-блоков и пропущенные блоки. */
export interface ProviderMcpSection {
  servers: UniversalMcpServer[];
  /** Файлы-блоки, которые панель не показывает и не правит, — с причиной. */
  skippedBlocks: SkippedMcpBlock[];
}
