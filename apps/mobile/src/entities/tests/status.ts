import type { ProjectTestStatus } from '@agentdeck/contracts';
import { colors } from '../../shared/config/theme';
import type { Language } from '../../shared/config/i18n';
import { formatDateTime } from '../../shared/lib/format';

/**
 * Как статус выглядит на телефоне. Отдельно от экранов: их теперь три (список,
 * ручной прогон, история), и три копии одной таблицы разошлись бы молча —
 * «провален» на одном экране красным, на другом серым.
 *
 * Значок — символ, а не только цвет: телефон с агентом смотрят на улице, и на
 * ярком солнце оттенок не читается вовсе.
 */
export const STATUS_MARK: Record<ProjectTestStatus, string> = {
  passed: '✓',
  failed: '✕',
  skipped: '–',
  blocked: '⊘',
  running: '…',
  unknown: '·',
};

export function statusColor(status: ProjectTestStatus): string {
  if (status === 'passed') return colors.success;
  if (status === 'failed') return colors.danger;
  if (status === 'blocked') return colors.warning;
  if (status === 'skipped') return colors.warning;
  if (status === 'running') return colors.running;
  return colors.textFaint;
}

/**
 * Момент прогона человеческим текстом на языке интерфейса (F-323). Пустая
 * строка — прогона не было; битое значение показывается как пришло.
 */
export function formatWhen(iso: string | undefined, language: Language): string {
  if (!iso) return '';
  return formatDateTime(iso, language) || iso;
}
