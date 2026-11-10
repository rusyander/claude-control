import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import type { TakeoverSubmitState } from '../../model/useTakeoverSubmit';

/** Итог последней команды перехвата: отказ ядра — его словами, сбой прокладки — её словами. */
export function TakeoverStatus({ state }: { state: TakeoverSubmitState }) {
  const { t } = useTranslation();
  switch (state.status) {
    case 'idle':
      return null;
    case 'sending':
      return (
        <Typography variant="caption" color="muted" role="status">
          {t('coreTakeover.sending')}
        </Typography>
      );
    case 'applied':
      return (
        <Typography variant="caption" color="success" role="status">
          {t(`coreTakeover.applied.${state.kind}`, { defaultValue: '' })}
        </Typography>
      );
    case 'rejected':
      return (
        <Typography variant="caption" color="danger" role="alert">
          {t('coreTakeover.refused', { reason: state.reason })}
        </Typography>
      );
    case 'failed':
      return (
        <Typography variant="caption" color="danger" role="alert">
          {t('coreTakeover.failed', { reason: state.reason })}
        </Typography>
      );
  }
}
