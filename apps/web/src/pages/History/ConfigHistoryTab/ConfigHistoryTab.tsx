import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { ExplainBox } from '@shared/ui/explain-box';
import { EmptyState } from '@shared/ui/empty-state';
import { SkeletonList } from '@shared/ui/skeleton';
import { useHistory } from '@entities/History';
import { HistoryItem } from '../HistoryItem/HistoryItem';

/**
 * История изменений конфигурации — временная лента правок с диффом.
 *
 * Панель делает резервную копию файла перед каждой записью, поэтому копии — это
 * снимки во времени. Вкладка собирает из них ленту: что за файл, когда и что
 * изменилось. Клик по записи раскрывает построчный дифф.
 */
export function ConfigHistoryTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useHistory();

  const items = data?.items ?? [];

  return (
    <Stack gap="var(--spacing-lg)">
      <ExplainBox title={t('history.explainTitle')} text={t('history.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      {!isLoading && items.length === 0 && (
        <EmptyState icon="history" title={t('history.empty')} text={t('history.emptyText')} />
      )}

      {items.length > 0 && (
        <Stack gap="var(--spacing-xs)">
          {items.map((entry) => (
            <HistoryItem key={entry.name} entry={entry} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
