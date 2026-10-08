import type { Language } from '../../shared/config/i18n';
import { formatDateTime } from '../../shared/lib/formatDateTime';

/**
 * Момент прогона человеческим текстом на языке интерфейса (F-323). Пустая
 * строка — прогона не было; битое значение показывается как пришло.
 */
export function formatWhen(iso: string | undefined, language: Language): string {
  if (!iso) return '';
  return formatDateTime(iso, language) || iso;
}
