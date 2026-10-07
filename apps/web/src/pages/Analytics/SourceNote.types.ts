export interface SourceNoteProps {
  /** Чьи сессии в отчёте: нет — Claude Code, иначе id чужого CLI. */
  providerId?: string;
  /** Модели без цены в прайсе: их расход посчитан нулём. */
  unpricedModels?: string[];
}
