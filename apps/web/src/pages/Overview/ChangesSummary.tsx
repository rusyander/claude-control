import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { useHistory } from '@entities/History';
import type { ChangesSummaryProps } from './ChangesSummary.types';
import styles from './OverviewPage.module.scss';

const DEFAULT_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Тип — `string`, а не литерал: у роутера нет статического дерева путей (маршруты
 * собираются циклом), и литерал `to` не прошёл бы проверку. Тот же приём, что у
 * HELP_ROUTE.
 */
const HISTORY_ROUTE: string = '/history';

/**
 * Сводка «изменилось за N дней»: сколько правок конфигурации накопилось за
 * период, с переходом в историю изменений.
 *
 * Логику не заводим: переиспользуем готовую ленту /api/history (тот же запрос,
 * что и на странице истории) и считаем на клиенте записи, снятые за последние N
 * дней. Одна правка одного файла = одна запись ленты — как их и показывает сама
 * история.
 */
export function ChangesSummary({ days = DEFAULT_DAYS }: ChangesSummaryProps) {
  const { t } = useTranslation();
  const { data } = useHistory();

  const count = useMemo(() => {
    const since = Date.now() - days * DAY_MS;
    return (data?.items ?? []).filter((entry) => {
      const at = Date.parse(entry.at);
      return Number.isFinite(at) && at >= since;
    }).length;
  }, [data, days]);

  return (
    <Link to={HISTORY_ROUTE} className={styles.changesLink}>
      <Card isInteractive padding="md">
        <Stack direction="row" align="center" gap="var(--spacing-sm)">
          <Icon name="history" size={24} />
          <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
            <Typography variant="body-sm" color="muted" as="span">
              {t('overview.changesTitle', { days })}
            </Typography>
            <Typography variant="heading-sm" as="span">
              {count}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {count > 0 ? t('overview.changesHint') : t('overview.changesNone')}
            </Typography>
          </Stack>
          <Icon name="chevronRight" size={20} />
        </Stack>
      </Card>
    </Link>
  );
}
