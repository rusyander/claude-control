export interface MrReviewNote {
  id: string;
  /** Логин автора. */
  author: string;
  /** Автор — бот (служебная учётная запись проекта, группы, CI). */
  bot?: boolean;
  body: string;
  createdAt?: string;
  /** Прямая ссылка на реплику, когда фордж её даёт (GitHub: `#discussion_r…`). */
  url?: string;
}

export interface MrReviewThread {
  id: string;
  /** Ветку можно закрыть — замечание к коду или «начать обсуждение». */
  resolvable: boolean;
  resolved: boolean;
  /** Реплики по порядку; служебные (`system`) уже выброшены. */
  notes: MrReviewNote[];
  path?: string;
  line?: number;
}

export interface MrReviewPipeline {
  id: string;
  /** Как назвал фордж: `running`, `success`, `failed`, `canceled`, `manual`… */
  status: string;
  url?: string;
}

export interface MrReview {
  state: 'open' | 'merged' | 'closed';
  /** Логин автора MR: его реплики — ответы, а не замечания. */
  author?: string;
  threads: MrReviewThread[];
  /** Конвейер головы MR; нет — не запускался. */
  pipeline?: MrReviewPipeline;
  /**
   * Описание MR как есть (аудит 25.09, L110): пустое описание — доставка не
   * закончена, её проверяет готовность группы по следам.
   */
  description?: string;
  /**
   * Фордж видит конфликт с целевой веткой. Нет поля — фордж не сказал (GitHub
   * считает это лениво и отвечает «неизвестно»), а не «конфликтов нет».
   */
  conflicts?: boolean;
}
