export const PREVIEW_WIDTH_KEY = 'claude-control:preview-width';

/** Примеры под рукой: пустой чат не должен встречать пустотой. */
export const SUGGESTIONS = ['page', 'explain', 'summarize'] as const;

/** Быстрые действия в пустом чате проекта: щелчок подставляет готовый запрос. */
export const PROJECT_ACTIONS = ['review', 'bugs', 'structure', 'tests'] as const;
