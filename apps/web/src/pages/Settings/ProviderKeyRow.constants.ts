/**
 * Тон значка по источнику ключа. Ключа нет — источник `null`, поэтому таблица
 * держит отдельный ключ `none`: так у каждого случая ровно одна строка.
 */
export const KEY_STATUS_TONE: Record<'stored' | 'env' | 'none', 'success' | 'info' | 'neutral'> = {
  stored: 'success',
  env: 'info',
  none: 'neutral',
};
