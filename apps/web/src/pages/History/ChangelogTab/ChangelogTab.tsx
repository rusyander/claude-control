import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearch } from '@tanstack/react-router';
import type { ChangelogKind } from '@agentdeck/contracts/changelog';
import { Button } from '@shared/ui/button';
import { EmptyState } from '@shared/ui/empty-state';
import { Icon } from '@shared/ui/icon';
import { LoadErrorCard } from '@shared/ui/load-error';
import { SkeletonList } from '@shared/ui/skeleton';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { cn } from '@shared/lib/cn';
import { useChangelog } from '@entities/Changelog';
import { ChangelogEntryCard } from '../ChangelogEntryCard/ChangelogEntryCard';
import { filterEntries, kindCounts, SOURCE_FILTERS, type SourceFilter } from '../model/filter';
import { KIND_COLOR, KIND_ORDER } from '../model/kinds';
import styles from './ChangelogTab.module.scss';

const PAGE_SIZE = 20;

/**
 * Вкладка «Что нового»: выпуски панели, свежее сверху. Открыт самый свежий из
 * показанных (или тот, на который указывает `?id=`). Источник и вид — отбор, а не
 * вид отображения: он живёт в памяти вкладки и не попадает в адрес, чтобы ссылка
 * вела на выпуск, а не на чужой отбор.
 */
export function ChangelogTab() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useChangelog();
  const { id: idParam } = useSearch({ strict: false }) as { id?: string };

  const [source, setSource] = useState<SourceFilter>('all');
  const [kinds, setKinds] = useState<ReadonlySet<ChangelogKind>>(new Set());
  // null — человек ещё ничего не раскрывал и не сворачивал: открыт выпуск по умолчанию.
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const scrolledTo = useRef<string | undefined>(undefined);

  const entries = useMemo(() => data?.entries ?? [], [data]);
  const filtered = useMemo(() => filterEntries(entries, source, kinds), [entries, source, kinds]);
  const counts = useMemo(() => kindCounts(entries, source), [entries, source]);

  const defaultOpenId = idParam ?? filtered[0]?.id;
  // Выпуск, на который указывает адрес, показывается, даже если он дальше первой страницы.
  const idIndex = idParam ? filtered.findIndex((entry) => entry.id === idParam) : -1;
  const shownCount = Math.max(visible, idIndex + 1);
  const shown = filtered.slice(0, shownCount);
  const remaining = filtered.length - shown.length;

  const isOpen = (id: string): boolean => (expanded ? expanded.has(id) : id === defaultOpenId);

  const toggle = (id: string): void => {
    const base = new Set(expanded ?? (defaultOpenId ? [defaultOpenId] : []));
    if (base.has(id)) base.delete(id);
    else base.add(id);
    setExpanded(base);
  };

  const toggleKind = (kind: ChangelogKind): void => {
    const next = new Set(kinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setKinds(next);
    setVisible(PAGE_SIZE);
  };

  const resetFilters = (): void => {
    setSource('all');
    setKinds(new Set());
    setVisible(PAGE_SIZE);
  };

  // Переход по `?id=`: один раз прокрутить к выпуску, когда лента загрузилась.
  useEffect(() => {
    if (!idParam || idIndex < 0 || scrolledTo.current === idParam) return;
    scrolledTo.current = idParam;
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-changelog-entry="${CSS.escape(idParam)}"]`)
        ?.scrollIntoView({ block: 'start' });
    });
  }, [idParam, idIndex]);

  if (isLoading) return <SkeletonList rows={5} />;
  if (isError || !data) return <LoadErrorCard onRetry={() => void refetch()} />;

  const filtersActive = source !== 'all' || kinds.size > 0;

  return (
    <Stack gap="var(--spacing-md)">
      {!data.gitAvailable && <p className={styles.note}>{t('changelog.gitMissing')}</p>}

      {data.invalid.length > 0 && (
        <div className={styles.warning} role="status">
          <Typography variant="body" weight="semibold">
            {t('changelog.invalidTitle', { count: data.invalid.length })}
          </Typography>
          <Typography variant="body-sm" color="muted">
            {t('changelog.invalidText')}
          </Typography>
          <ul className={styles.invalidList}>
            {data.invalid.map((item) => (
              <li key={item.file}>
                <code>{item.file}</code> — {item.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {entries.length > 0 && (
        <div className={styles.toolbar}>
          <div className={styles.group} role="group" aria-label={t('changelog.source.label')}>
            {SOURCE_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                className={cn(styles.segment, source === value && styles.segmentActive)}
                aria-pressed={source === value}
                onClick={() => {
                  setSource(value);
                  setVisible(PAGE_SIZE);
                }}
              >
                {t(`changelog.source.${value}`)}
              </button>
            ))}
          </div>

          <div className={styles.group} role="group" aria-label={t('changelog.kindsLabel')}>
            {KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) => (
              <button
                key={kind}
                type="button"
                className={cn(styles.chip, kinds.has(kind) && styles.chipActive)}
                aria-pressed={kinds.has(kind)}
                onClick={() => toggleKind(kind)}
              >
                <span className={styles.dot} style={{ background: KIND_COLOR[kind] }} />
                {t(`changelog.kinds.${kind}`)}
                <span className={styles.chipCount}>{counts.get(kind)}</span>
              </button>
            ))}
          </div>

          <Stack direction="row" gap="var(--spacing-xs)" className={styles.bulk}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(new Set(shown.map((entry) => entry.id)))}
            >
              {t('changelog.expandAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setExpanded(new Set())}>
              {t('changelog.collapseAll')}
            </Button>
          </Stack>
        </div>
      )}

      {entries.length === 0 && (
        <EmptyState
          icon="calendar"
          title={t('changelog.empty.title')}
          text={t('changelog.empty.text')}
        />
      )}

      {entries.length > 0 && filtered.length === 0 && (
        <EmptyState
          icon="search"
          title={t('changelog.empty.filtered')}
          action={
            filtersActive ? (
              <Button
                variant="secondary"
                leftIcon={<Icon name="refresh" size={16} />}
                onClick={resetFilters}
              >
                {t('changelog.empty.reset')}
              </Button>
            ) : undefined
          }
        />
      )}

      {shown.length > 0 && (
        <ul className={styles.list} aria-label={t('changelog.listLabel')}>
          {shown.map((entry) => (
            <li key={entry.id}>
              <ChangelogEntryCard
                entry={entry}
                isOpen={isOpen(entry.id)}
                onToggle={() => toggle(entry.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {remaining > 0 && (
        <div className={styles.more}>
          <Button variant="secondary" onClick={() => setVisible(shownCount + PAGE_SIZE)}>
            {t('changelog.showMore', { count: Math.min(PAGE_SIZE, remaining) })}
          </Button>
        </div>
      )}
    </Stack>
  );
}
