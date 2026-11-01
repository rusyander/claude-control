import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { signalRows } from '../../model/signals';
import { SignalLine } from '../SignalLine/SignalLine';
import type { SignalsPanelProps } from './SignalsPanel.types';

/**
 * Сигналы и подсказки (F14): строки `signal` журнала — что ядро заметило и что сделало (показало,
 * подсказало сессии, остановило шаг, поставило паузу). Новые сверху: свежий сигнал важнее старого.
 */
export function SignalsPanel({ fold }: SignalsPanelProps) {
  const { t } = useTranslation();
  const signals = useMemo(() => signalRows(fold), [fold]);
  return (
    <Card padding="md" data-core-signals={signals.length}>
      <Stack gap="var(--spacing-xs)">
        <Typography variant="heading-sm" as="h2">
          {t('coreTimeline.signal.title')}
        </Typography>
        {signals.length === 0 && (
          <Typography variant="caption" color="subtle">
            {t('coreTimeline.signal.none')}
          </Typography>
        )}
        {signals.map(({ seq, signal }) => (
          <div key={seq} data-core-signal={signal.signal}>
            {/* Серьёзность — значком, поэтому заголовок без цвета тона: два сигнала одного смысла. */}
            <SignalLine signal={signal} tone="default" withSeverity />
          </div>
        ))}
      </Stack>
    </Card>
  );
}
