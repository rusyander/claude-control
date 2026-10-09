import { useTranslation } from 'react-i18next';
import {
  WatcherSummary,
  useSetWatcher,
  useWatcherElapsed,
  useWatcherStatus,
} from '@entities/Watcher';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Button } from '@shared/ui/button';
import type { WatcherControlCardProps } from './WatcherControlCard.types';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Пульт наблюдателя — единственное место, где его запускают (владелец
 * 09.10.2026: из настроек наблюдатель переехал на свою страницу, строка в
 * боковой панели видна всегда и ведёт сюда). Кнопка, а не тумблер: запуск —
 * действие с расходом, и подпись «Запустить наблюдателя» говорит это прямо.
 */
export function WatcherControlCard({ costUnit }: WatcherControlCardProps) {
  const { t } = useTranslation();
  const { data: status, dataUpdatedAt, isError, error, refetch, isFetching } = useWatcherStatus();
  const setWatcher = useSetWatcher();
  const elapsed = useWatcherElapsed(status, dataUpdatedAt);
  const loaded = status !== undefined;
  const enabled = status?.enabled === true;

  const toggle = (next: boolean): void => {
    setWatcher.mutate(next, {
      onError: (cause) =>
        toast.error(t('watcher.toggleFailed', { message: toErrorMessage(cause) })),
    });
  };

  return (
    <Card padding="md" data-watcher-control>
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)" wrap>
          <Stack gap="var(--spacing-3xs)" className="prose">
            <Typography variant="body" weight="medium" as="span">
              {t('watcher.toggleLabel')}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {t('watcher.toggleHint')}
            </Typography>
          </Stack>
          {enabled ? (
            <Button
              variant="secondary"
              onClick={() => toggle(false)}
              isLoading={setWatcher.isPending}
              data-watcher-stop
            >
              {t('watcher.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => toggle(true)}
              isLoading={setWatcher.isPending}
              disabled={!loaded}
              data-watcher-start
            >
              {t('watcher.start')}
            </Button>
          )}
        </Stack>

        <Typography variant="body-sm" color="muted">
          {t('watcher.cardHint')}
        </Typography>

        {/* Состояние не прочиталось: кнопка заперта, и без причины рядом она
            читалась бы как поломка раздела (ревью 28.09, F-302). */}
        {!loaded && isError && (
          <Stack direction="row" align="center" gap="var(--spacing-sm)" wrap>
            <Typography variant="body-sm" color="danger" role="alert">
              {t('watcher.statusFailed', { message: toErrorMessage(error) })}
            </Typography>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void refetch()}
              isLoading={isFetching}
            >
              {t('common.retry')}
            </Button>
          </Stack>
        )}

        {status &&
          (status.enabled || status.findings > 0 || status.problem ? (
            <WatcherSummary status={status} elapsed={elapsed} costUnit={costUnit} />
          ) : (
            <Typography variant="body-sm" color="subtle" as="span">
              {t('watcher.offState')}
            </Typography>
          ))}
      </Stack>
    </Card>
  );
}
