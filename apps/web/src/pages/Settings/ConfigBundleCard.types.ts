/** Как поступить с правилами (CLAUDE.md) при импорте бандла. */
export type BundleRulesMode = 'append' | 'replace' | 'skip';

/**
 * Разбор бандла на клиенте для предпросмотра. Сам бандл (`raw`) уходит на сервер
 * как есть — клиент только считает, что внутри, чтобы показать перед применением.
 */
export interface BundlePreview {
  /** Разобранный JSON бандла — отправляется на сервер без изменений. */
  raw: unknown;
  /** Строк текста правил (CLAUDE.md). */
  rulesLines: number;
  /** Скиллов в бандле. */
  skills: number;
  /** Хуков в бандле. */
  hooks: number;
}

/** Итог применения бандла — что сервер создал/пропустил. */
export interface BundleImportSummary {
  rulesApplied: boolean;
  skillsCreated: string[];
  skillsSkipped: string[];
  hooksAdded: number;
  hooksSkipped: number;
}
