import type { AppSettings, ProviderSkillsScope } from '@claude-control/contracts';
import type { ConfigProvider } from '../../providers/types.ts';

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
export interface ProviderSkillsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/** Разрешённая цель раздела: провайдер + каталог скиллов. */
export interface ProviderSkillsTarget {
  provider: ConfigProvider;
  format: 'skill-md-dir';
  scope: ProviderSkillsScope;
  /** Абсолютный путь каталога скиллов. */
  skillsDir: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
  /**
   * Каталоги, из которых CLI ТОЖЕ грузит скиллы, но которыми раздел НЕ
   * управляет (только показывает). Задаются лишь на глобальном уровне.
   */
  externalDirs: string[];
  /** Предел длины описания у ЭТОГО CLI (у Kimi — 240, у остальных 1024). */
  descriptionMax?: number;
}
