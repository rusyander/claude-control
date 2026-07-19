import { useTranslation } from 'react-i18next';
import { Badge } from '@shared/ui/badge';
import type { SourceBadgeProps } from './source-badge.types';

/**
 * Пометка «эта запись из settings.local.json».
 *
 * Claude Code читает локальный файл наравне с основным, поэтому панель его
 * показывает — иначе список врал бы о том, что действует. Но править не
 * берётся: файл личный. Бейдж и объясняет, почему у записи нет кнопок.
 */
export function SourceBadge({ source }: SourceBadgeProps) {
  const { t } = useTranslation();

  if (source !== 'settings-local') return null;

  return (
    <span title={t('common.localReadOnly')}>
      <Badge tone="info">{t('common.sourceLocal')}</Badge>
    </span>
  );
}
