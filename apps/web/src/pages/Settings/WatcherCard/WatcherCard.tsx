import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouterState } from '@tanstack/react-router';
import {
  WATCHER_ANCHOR,
  WATCHER_FOCUS_EVENT,
  WatcherSummary,
  useSetWatcher,
  useWatcherElapsed,
  useWatcherStatus,
} from '@entities/Watcher';
import { toast } from '@shared/lib/toast';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import type { WatcherCardProps } from './WatcherCard.types';
import { toErrorMessage } from '../../../shared/api/toErrorMessage';

/**
 * Карточка фонового наблюдателя во вкладке «Общие». Тумблер — единственное
 * место, где наблюдатель включают; индикатор в боковой панели умеет только
 * выключить и привести сюда.
 *
 * Якорь `#watcher`: пришли по ссылке «Перейти в настройки» — карточка
 * прокручивается к себе и ставит фокус на тумблер. Уже открытая вкладка
 * адреса не меняет, поэтому индикатор дополнительно шлёт событие окна.
 */
export function WatcherCard({ costUnit }: WatcherCardProps) {
  const { t } = useTranslation();
  const { data: status, dataUpdatedAt, isError, error, refetch, isFetching } = useWatcherStatus();
  const setWatcher = useSetWatcher();
  const elapsed = useWatcherElapsed(status, dataUpdatedAt);
  const cardRef = useRef<HTMLDivElement>(null);
  const hash = useRouterState({ select: (state) => state.location.hash });
  const loaded = status !== undefined;

  useEffect(() => {
    const focusToggle = (): void => {
      const card = cardRef.current;
      const toggle = card?.querySelector<HTMLElement>('[role="switch"]');
      if (!card || !toggle) return;
      card.scrollIntoView({ block: 'center' });
      toggle.focus({ preventScroll: true });
    };
    if (loaded && hash.replace(/^#/, '') === WATCHER_ANCHOR) focusToggle();
    window.addEventListener(WATCHER_FOCUS_EVENT, focusToggle);
    return () => window.removeEventListener(WATCHER_FOCUS_EVENT, focusToggle);
  }, [hash, loaded]);

  const toggle = (enabled: boolean): void => {
    setWatcher.mutate(enabled, {
      onError: (error) =>
        toast.error(t('watcher.toggleFailed', { message: toErrorMessage(error) })),
    });
  };

  return (
    <div id={WATCHER_ANCHOR} ref={cardRef} data-watcher-card>
      <Card padding="md">
        <Stack gap="var(--spacing-sm)">
          <Stack direction="row" align="center" justify="between" gap="var(--spacing-md)">
            <Stack gap="var(--spacing-3xs)" className="prose">
              <Typography variant="body" weight="medium" as="span">
                {t('watcher.toggleLabel')}
              </Typography>
              <Typography variant="caption" color="subtle" as="span">
                {t('watcher.toggleHint')}
              </Typography>
            </Stack>
            <Toggle
              checked={status?.enabled === true}
              onCheckedChange={toggle}
              disabled={!loaded || setWatcher.isPending}
              aria-label={t('watcher.toggleLabel')}
            />
          </Stack>

          <Typography variant="body-sm" color="muted">
            {t('watcher.cardHint')}
          </Typography>

          {/* Состояние не прочиталось: тумблер заперт, и без причины рядом он
              читался бы как поломка раздела (ревью 28.09, F-302). */}
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
              <WatcherSummary
                status={status}
                elapsed={elapsed}
                costUnit={costUnit}
                showReportPath
              />
            ) : (
              <Typography variant="body-sm" color="subtle" as="span">
                {t('watcher.offState')}
              </Typography>
            ))}
        </Stack>
      </Card>
    </div>
  );
}
