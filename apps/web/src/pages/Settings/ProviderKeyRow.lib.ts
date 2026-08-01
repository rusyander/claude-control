import type { TFunction } from 'i18next';
import type { KeyStatus } from '@claude-control/contracts';

/**
 * Подпись статуса ключа. Сохранённый в панели показываем маской, подхваченный
 * из окружения — ещё и именем переменной, иначе говорим, что ключа нет.
 */
export function keyStatusLabel(status: KeyStatus, t: TFunction): string {
  if (status.source === 'stored') return t('providerKeys.statusStored', { masked: status.masked });
  if (status.source === 'env') {
    return t('providerKeys.statusEnv', { envVar: status.envVar ?? '', masked: status.masked });
  }
  return t('providerKeys.statusNone');
}
