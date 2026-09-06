import type { ErrorInfo, ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Что показать вместо упавшего поддерева; функция получает ошибку и сброс. */
  fallback: ReactNode | ((error: unknown, reset: () => void) => ReactNode);
  /** Имя места для консоли: по нему в логе видно, ЧТО упало, без чтения стека. */
  scope?: string;
  onError?: (error: unknown, info: ErrorInfo) => void;
}

export interface ErrorBoundaryState {
  error: unknown;
  failed: boolean;
}

export interface CrashCardProps {
  error: unknown;
  /** Свой заголовок; по умолчанию общий «раздел не смог отрисоваться». */
  title?: string;
  /** Своё пояснение; по умолчанию общее — про код панели, а не данные. */
  text?: string;
  /** Попробовать отрисовать снова без перезагрузки вкладки. */
  onRetry?: () => void;
  /**
   * Тесная форма для места внутри ленты: одна строка и «скопировать», без
   * заголовка и без «обновить страницу» — вокруг живой чат, его не перезагружают.
   */
  compact?: boolean;
}
