import type { WatchUserCheck } from '@entities/Watcher';

export interface WatcherBugCheckProps {
  /** Проверки человека из статуса — свежие первыми. */
  checks: readonly WatchUserCheck[];
  /** Сколько проверок показать; без значения — все. Окну индикатора тесно, странице — нет. */
  limit?: number;
}
