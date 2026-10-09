import { useTranslation } from 'react-i18next';
import { useSettings } from '@entities/AppConfig';
import { useWatcherStatus } from '@entities/Watcher';
import { WatcherBugCheck } from '@features/WatcherIndicator';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { PageHeader } from '@shared/ui/page-header';
import { WatcherControlCard } from '../WatcherControlCard/WatcherControlCard';
import { WatcherReport } from '../WatcherReport/WatcherReport';

/**
 * Страница наблюдателя `/watcher` (владелец 09.10.2026): запуск, «Нашли баг
 * сами?» и отчёт в одном месте. Раньше пульт жил карточкой в настройках, а
 * строка в боковой панели появлялась только у включённого — до выключенного
 * наблюдателя приходилось знать дорогу.
 *
 * Форма бага видна только у запущенного: проверяет её модель наблюдателя, и
 * сервер у выключенного отвечает 409 — вместо формы, которая всегда падает,
 * стоит подсказка, что сначала нужен запуск.
 */
export function WatcherPage() {
  const { t } = useTranslation();
  const { data: settings } = useSettings();
  const { data: status } = useWatcherStatus();
  const costUnit = settings?.costUnit ?? 'tokens';

  return (
    <Stack gap="var(--spacing-lg)" data-watcher-page>
      <PageHeader
        title={t('watcher.page.title')}
        subtitle={t('watcher.page.subtitle')}
        helpTopic="watcher"
      />
      <WatcherControlCard costUnit={costUnit} />
      <Card padding="md" data-watcher-bug-card>
        {status?.enabled === true ? (
          <WatcherBugCheck checks={status.checks ?? []} />
        ) : (
          <Stack gap="var(--spacing-3xs)">
            <Typography variant="body-sm" weight="medium" as="span">
              {t('watcher.bug.title')}
            </Typography>
            <Typography variant="caption" color="subtle" as="span" data-watcher-bug-off>
              {t('watcher.bug.off')}
            </Typography>
          </Stack>
        )}
      </Card>
      <WatcherReport />
    </Stack>
  );
}
