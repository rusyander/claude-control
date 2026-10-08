import type { Language } from '../config/i18n';
import { moment } from './moment';

/**
 * Время суток на языке ИНТЕРФЕЙСА приложения, а не системы телефона: русский
 * интерфейс на английском телефоне показывал «03:04 PM» (F-323). Битое значение
 * даёт пустоту, не «Invalid Date».
 */
export function formatClock(
  at: string | number,
  language: Language,
  { seconds = false }: { seconds?: boolean } = {},
): string {
  const date = moment(at);
  if (!date) return '';
  return date.toLocaleTimeString(language, {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' as const } : {}),
  });
}
