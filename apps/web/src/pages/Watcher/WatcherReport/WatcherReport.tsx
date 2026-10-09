import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWatcherReport } from '@entities/Watcher';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { LoadErrorCard } from '@shared/ui/load-error';
import { TabButton } from '@shared/ui/tab-button';
import { formatDateTime } from '@shared/lib/formatDateTime';
import { WatcherReportSection } from '../WatcherReportSection/WatcherReportSection';
import { REPORT_FILTERS, matchesFilter, type ReportFilter } from '../model/filters';
import styles from './WatcherReport.module.scss';

/**
 * Отчёт наблюдателя на его странице (владелец 09.10.2026): тот же `WATCH-REPORT.md`,
 * что пересылают агенту, только разделами-карточками с метками и фильтрами —
 * читать Markdown-файл в редакторе ради «что там нашлось» неудобно.
 *
 * Страница только читает: что попадает в отчёт, решает наблюдатель, и
 * подтверждённые по описанию человека баги появляются здесь сами, со
 * следующим опросом.
 */
export function WatcherReport() {
  const { t, i18n } = useTranslation();
  const { data, isLoading, isError, refetch } = useWatcherReport();
  const [filter, setFilter] = useState<ReportFilter>('all');

  const header = (
    <Stack gap="var(--spacing-3xs)">
      <Typography variant="heading-sm" as="h2">
        {t('watcher.page.reportTitle')}
      </Typography>
      <Typography variant="body-sm" color="muted" className="prose">
        {t('watcher.page.reportHint')}
      </Typography>
    </Stack>
  );

  if (isError && !data) {
    return (
      <Stack gap="var(--spacing-sm)">
        {header}
        <LoadErrorCard title={t('watcher.page.loadFailed')} onRetry={() => void refetch()} />
      </Stack>
    );
  }
  if (isLoading || !data) return <SkeletonList rows={4} />;

  const sections = data.sections;
  const shown = sections.filter((section) => matchesFilter(section, filter));

  return (
    <Stack gap="var(--spacing-sm)" data-watcher-report>
      {header}
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="caption" color="subtle" as="span">
          {t('watcher.page.file')}:{' '}
          <span className={styles.path} data-watcher-report-path>
            {data.path}
          </span>
        </Typography>
        {data.updatedAt && (
          <Typography variant="caption" color="subtle" as="span">
            {t('watcher.page.updated', { date: formatDateTime(data.updatedAt, i18n.language) })}
          </Typography>
        )}
      </Stack>

      {sections.length === 0 ? (
        <EmptyState
          icon="file"
          title={t('watcher.page.empty')}
          text={t('watcher.page.emptyText')}
        />
      ) : (
        <Stack gap="var(--spacing-sm)">
          <div role="group" aria-label={t('watcher.page.filterLabel')} className={styles.filters}>
            {REPORT_FILTERS.map((id) => (
              <TabButton key={id} isActive={filter === id} onClick={() => setFilter(id)}>
                {t(`watcher.page.filter.${id}`, {
                  count: sections.filter((section) => matchesFilter(section, id)).length,
                })}
              </TabButton>
            ))}
          </div>
          {shown.length === 0 ? (
            <Typography variant="body-sm" color="subtle">
              {t('watcher.page.noMatch')}
            </Typography>
          ) : (
            <ul className={styles.list}>
              {shown.map((section) => (
                <li key={section.id}>
                  <WatcherReportSection section={section} />
                </li>
              ))}
            </ul>
          )}
        </Stack>
      )}
    </Stack>
  );
}
