import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { SearchResultKind } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { IconName } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import { useDebouncedValue } from '@shared/hooks/use-debounced-value';
import { useSearch, MIN_SEARCH_LENGTH } from '@entities/Search';
import { groupResults } from './model/groupResults';
import styles from './SearchPage.module.scss';

/** Иконка раздела, из которого пришёл результат. */
const KIND_ICON: Record<SearchResultKind, IconName> = {
  rule: 'rules',
  skill: 'skills',
  hook: 'hooks',
  script: 'scripts',
  plugin: 'plugins',
  mcp: 'mcp',
  permission: 'permissions',
  env: 'env',
};

/** Глобальный поиск по всем разделам конфигурации. */
export function SearchPage() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query);

  const trimmed = debounced.trim();
  const isReady = trimmed.length >= MIN_SEARCH_LENGTH;
  const { data, isLoading } = useSearch(debounced);

  const groups = useMemo(() => groupResults(data?.results ?? []), [data]);
  const total = data?.results.length ?? 0;

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader title={t('search.title')} subtitle={t('search.subtitle')} />

      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t('search.placeholder')}
        label={t('search.title')}
      />

      {!isReady && (
        <EmptyState icon="search" title={t('search.promptTitle')} text={t('search.promptText')} />
      )}

      {isReady && isLoading && <SkeletonList rows={5} />}

      {isReady && !isLoading && total === 0 && (
        <EmptyState
          icon="search"
          title={t('search.emptyTitle')}
          text={t('search.emptyText', { query: trimmed })}
        />
      )}

      {isReady && total > 0 && (
        <Stack gap="var(--spacing-xs)">
          <Typography variant="body-sm" color="subtle">
            {t('search.resultsCount', { count: total })}
          </Typography>

          {groups.map((group) => (
            <Stack key={group.kind} gap="var(--spacing-xs)">
              <Stack direction="row" align="center" gap="var(--spacing-xs)">
                <Icon name={KIND_ICON[group.kind]} size={24} />
                <Typography variant="heading-sm" as="h2">
                  {t(`search.section.${group.kind}`)}
                </Typography>
                <Badge tone="neutral">{group.results.length}</Badge>
              </Stack>

              <Stack gap="var(--spacing-2xs)">
                {group.results.map((result) => (
                  <Link
                    key={`${result.kind}:${result.id}`}
                    // Путь раздела приходит с сервера строкой, поэтому тип — общий
                    // string: конкретный литерал роутера тут не вывести.
                    to={`/${result.pagePath}` as string}
                    search={{ id: result.id }}
                    className={styles.resultLink}
                  >
                    <Card isInteractive padding="md">
                      <Stack gap="var(--spacing-3xs)" minWidth={0}>
                        <Typography variant="body" weight="medium" as="span" truncate>
                          {result.title}
                        </Typography>
                        {result.snippet && (
                          <Typography
                            variant="body-sm"
                            color="muted"
                            clamp={2}
                            className={styles.snippet}
                          >
                            {result.snippet}
                          </Typography>
                        )}
                      </Stack>
                    </Card>
                  </Link>
                ))}
              </Stack>
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
