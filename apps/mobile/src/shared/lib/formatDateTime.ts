import type { Language } from '../config/i18n';
import { moment } from './moment';

/** Дата со временем на языке интерфейса — та же граница, что у `formatClock`. */
export function formatDateTime(at: string | number, language: Language): string {
  const date = moment(at);
  return date ? date.toLocaleString(language) : '';
}
