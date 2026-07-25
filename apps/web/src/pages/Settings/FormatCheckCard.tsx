import { useTranslation } from 'react-i18next';
import type { FormatCheckProvider, FormatCheckState } from '@claude-control/contracts';
import { Card } from '@shared/ui/card';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { formatDate } from '@shared/lib/format';
import { toast } from '@shared/lib/toast';
import { useProviders } from '@entities/Provider';
import { useFormatCheck, useRefreshFormatCheck } from '@entities/FormatCheck';
import styles from './FormatCheckCard.module.scss';

/**
 * Сверка форматов чужих CLI с их официальными схемами (IDEA-3).
 *
 * Панель пишет чужие конфигурации по документации, а документация уезжает вместе
 * с релизами. Карточка отвечает на один вопрос: ключи, которые панель РЕАЛЬНО
 * правит, всё ещё есть в опубликованной схеме этого CLI?
 *
 * Расхождение ничего не блокирует — это повод посмотреть глазами. И наоборот:
 * там, где схема официально не публикуется, честно написано «сверять не с чем»,
 * а не успокаивающее «всё в порядке».
 */
export function FormatCheckCard() {
  const { t, i18n } = useTranslation();
  const { data: providers } = useProviders();
  const { data } = useFormatCheck();
  const refresh = useRefreshFormatCheck();

  if (!data) return null;

  const providerName = (id: string): string =>
    providers?.providers.find((item) => item.id === id)?.name ?? id;

  const rows = data.report?.providers ?? [];
  const drifted = rows.filter((row) => row.state === 'drift').length;

  const run = (): void => {
    refresh.mutate(undefined, {
      onSuccess: (report) => {
        const bad = report.providers.filter((row) => row.state === 'drift').length;
        if (bad > 0) toast.error(t('formatCheck.doneDrift', { count: bad }));
        else toast.success(t('formatCheck.doneOk'));
      },
      onError: () => toast.error(t('formatCheck.error')),
    });
  };

  return (
    <Card padding="md">
      <Stack gap="var(--spacing-sm)">
        <Stack direction="row" align="center" justify="between" gap="var(--spacing-sm)" wrap>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium">
              {t('formatCheck.title')}
            </Typography>
            {drifted > 0 && (
              <Badge tone="warning">{t('formatCheck.drifted', { count: drifted })}</Badge>
            )}
          </Stack>
          <Button
            variant="secondary"
            size="sm"
            isLoading={refresh.isPending}
            leftIcon={<Icon name="refresh" size={16} />}
            onClick={run}
          >
            {t('formatCheck.run')}
          </Button>
        </Stack>

        {/* Ширина по мере читаемости: без ограничения текст растягивается на всю
            карточку и читается хуже (ловится аудитом раскладки). */}
        <Typography variant="body-sm" color="subtle" style={{ maxWidth: 'var(--text-measure)' }}>
          {t('formatCheck.hint')}
        </Typography>

        {data.report ? (
          <Stack gap="var(--spacing-xs)">
            <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
              <Typography variant="caption" color="subtle">
                {t('formatCheck.checkedAt', {
                  date: formatDate(data.report.checkedAt, i18n.language),
                })}
              </Typography>
              {data.stale && <Badge tone="warning">{t('formatCheck.stale')}</Badge>}
            </Stack>
            <Stack gap="0" className={styles.list}>
              {rows.map((row) => (
                <FormatCheckRow
                  key={row.providerId}
                  row={row}
                  name={providerName(row.providerId)}
                />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Typography variant="body-sm" color="subtle">
            {t('formatCheck.never')}
          </Typography>
        )}
      </Stack>
    </Card>
  );
}

/** Итог по одному CLI: состояние, ведомые ключи и пояснение. */
function FormatCheckRow({ row, name }: { row: FormatCheckProvider; name: string }) {
  const { t } = useTranslation();

  return (
    <Stack direction="row" align="start" gap="var(--spacing-xs)" className={styles.row} wrap>
      <Badge tone={stateTone(row.state)}>{t(`formatCheck.state.${row.state}`)}</Badge>
      <Stack gap="var(--spacing-3xs)" className={styles.text}>
        <Typography variant="body-sm" as="span">
          {name}
        </Typography>
        {row.note && (
          <Typography variant="caption" color="subtle" as="span">
            {row.note}
          </Typography>
        )}
        {row.keys.map((key) => (
          <span key={key.path} className={styles.key}>
            {key.present
              ? t('formatCheck.keyPresent', { path: key.path })
              : t('formatCheck.keyMissing', { path: key.path })}
          </span>
        ))}
      </Stack>
    </Stack>
  );
}

/** Цвет бейджа по состоянию. Отсутствие схемы — не тревога, а факт. */
function stateTone(state: FormatCheckState): 'success' | 'warning' | 'neutral' {
  if (state === 'ok') return 'success';
  if (state === 'drift') return 'warning';
  return 'neutral';
}
