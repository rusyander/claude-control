import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { StatusDot } from '@shared/ui/status-dot';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { usePlatformGateway, useStartGateway } from '@entities/Platform';
import styles from './PlatformPage.module.scss';

/**
 * Активный контур при погашенном шлюзе — с кнопкой прямо здесь.
 *
 * Живое подключение 14.09.2026: карточка говорила «Шлюз не поднят», а поднять
 * его можно было только в мастере на последнем шаге, и отказ обязательного
 * контура в чате отправлял туда же тремя переходами. Строка стоит только пока
 * шлюз действительно лежит: состояние берётся у слушателя, а не у старого
 * пробного запроса.
 */
export function GatewayDownLine() {
  const { t } = useTranslation();
  const gateway = usePlatformGateway();
  const start = useStartGateway();

  if (!gateway.data || gateway.data.status.running) return null;

  const run = (): void => {
    start.mutate(undefined, {
      onSuccess: (info) =>
        toast.success(t('platform.gatewayStarted', { address: info.status.address ?? '' })),
      onError: (error) => toast.error(toErrorMessage(error)),
    });
  };

  return (
    <Stack gap="var(--spacing-3xs)" className={styles.problem} data-gateway-down>
      <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
        <StatusDot tone="warning" />
        <Typography variant="body-sm">{t('platform.gatewayDownCard')}</Typography>
        <Button variant="secondary" size="sm" onClick={run} isLoading={start.isPending}>
          {t('platform.gatewayStart')}
        </Button>
      </Stack>
      <Typography variant="caption" color="muted">
        {t('platform.gatewayDownCardHint')}
      </Typography>
    </Stack>
  );
}
