import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SearchField } from '@shared/ui/search-field';
import { SkeletonList } from '@shared/ui/skeleton';
import { EmptyState } from '@shared/ui/empty-state';
import {
  useCommands,
  buildCommandRows,
  filterCommands,
  filterBySource,
  countBySource,
  type CommandRow,
  type CommandFilter,
  type CommandLocale,
} from '@entities/Command';
import styles from './CommandsPage.module.scss';

/**
 * Всё, что вызывается через `/`, одним списком.
 *
 * Зачем: команд набирается под сотню, и по имени в палитре не понять ни что
 * команда делает, ни чья она, ни где её править. Здесь у каждой есть описание,
 * владелец, путь и — если есть куда — кнопка перехода в раздел, где она живёт.
 *
 * Раздел ЧИТАЮЩИЙ. Скилл правится в разделе скиллов, плагин — в разделе
 * плагинов, встроенная не правится вовсе: у неё нет файла.
 */

const FILTERS: CommandFilter[] = ['all', 'skill', 'command', 'plugin', 'builtin'];

export function CommandsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<CommandFilter>('all');

  const { data, isLoading } = useCommands();
  const locale: CommandLocale = i18n.language.startsWith('en') ? 'en' : 'ru';

  const rows = useMemo(
    () => buildCommandRows(data?.commands ?? [], locale),
    [data?.commands, locale],
  );
  const counts = useMemo(() => countBySource(rows), [rows]);
  const visible = useMemo(
    () => filterBySource(filterCommands(rows, query), filter),
    [rows, query, filter],
  );

  // Путь собирается строкой: типизированного дерева маршрутов здесь нет —
  // отсюда приведение (так же ходит командная палитра).
  const open = (row: CommandRow): void => {
    const to = row.target === 'skill' ? '/skills' : '/plugins';
    void navigate({ to, search: { id: row.targetId } } as never);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('commands.title')}
        subtitle={t('commands.subtitle', { count: rows.length })}
        helpTopic="commands"
      />

      <ExplainBox title={t('commands.explainTitle')} text={t('commands.explain')} />

      <Stack direction="row" gap="var(--spacing-sm)" wrap align="center">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('commands.searchPlaceholder')}
          label={t('common.search')}
        />

        <Stack direction="row" gap="var(--spacing-2xs)" wrap>
          {FILTERS.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? 'primary' : 'ghost'}
              onClick={() => setFilter(value)}
            >
              {t(`commands.filter.${value}`)} · {counts[value]}
            </Button>
          ))}
        </Stack>
      </Stack>

      {data?.notes.map((note) => (
        <Typography key={note} variant="caption" color="subtle">
          {note}
        </Typography>
      ))}

      {isLoading && <SkeletonList rows={6} />}

      {!isLoading && visible.length === 0 && (
        <EmptyState icon="search" title={t('commands.emptyTitle')} text={t('commands.emptyText')} />
      )}

      {visible.length > 0 && (
        <Card padding="none">
          <Stack>
            {visible.map((row) => (
              <CommandItem key={row.id} row={row} onOpen={() => open(row)} />
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}

interface CommandItemProps {
  row: CommandRow;
  onOpen: () => void;
}

function CommandItem({ row, onOpen }: CommandItemProps) {
  const { t } = useTranslation();
  const canOpen = row.target !== 'none' && Boolean(row.targetId);

  return (
    <Stack
      direction="row"
      align="start"
      justify="between"
      gap="var(--spacing-sm)"
      className={styles.row}
      data-command={row.invocation}
    >
      <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Typography variant="mono" weight="medium" as="span">
            {row.invocation}
          </Typography>
          {row.argumentHint && (
            <Typography variant="mono" color="subtle" as="span" className={styles.hint}>
              {row.argumentHint}
            </Typography>
          )}

          <Badge tone={sourceTone(row)}>{t(`commands.source.${row.source}`)}</Badge>
          {/* «Bundled skill» и связка агентов ведут себя иначе обычной команды:
              их Claude может позвать сам, поэтому тип видно сразу. */}
          {row.builtinKind && row.builtinKind !== 'builtin' && (
            <Badge tone="info">{t(`commands.kind.${row.builtinKind}`)}</Badge>
          )}
          {row.isRemoved && <Badge tone="danger">{t('commands.removed')}</Badge>}
          {!row.isEnabled && !row.isRemoved && (
            <Badge tone="warning">{t('commands.disabled')}</Badge>
          )}
        </Stack>

        {row.description && (
          <Typography variant="caption" color="subtle" className={styles.description}>
            {row.description}
          </Typography>
        )}

        <Stack direction="row" gap="var(--spacing-sm)" wrap className={styles.meta}>
          {row.owner && (
            <Typography variant="caption" color="subtle" as="span">
              {t('commands.owner')}: {row.owner}
            </Typography>
          )}
          {row.aliases.length > 0 && (
            <Typography variant="caption" color="subtle" as="span">
              {t('commands.aliases')}: {row.aliases.map((alias) => `/${alias}`).join(', ')}
            </Typography>
          )}
        </Stack>

        {/* Семья — ответ на «с чем эта команда ходит парой»: соседи по префиксу
            имени или по плагину. */}
        {row.family.length > 0 && (
          <Typography variant="caption" color="subtle" as="span" className={styles.line}>
            {t('commands.family')}: {row.family.join(', ')}
          </Typography>
        )}

        {row.related.length > 0 && (
          <Typography variant="caption" color="subtle" as="span" className={styles.line}>
            {t('commands.related')}: {row.related.map((name) => `/${name}`).join(', ')}
          </Typography>
        )}

        {row.path && (
          <Typography variant="caption" color="subtle" as="span" className={styles.path}>
            {row.path}
          </Typography>
        )}
      </Stack>

      {canOpen && (
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<Icon name="edit" size={18} />}
          onClick={onOpen}
        >
          {t('commands.open')}
        </Button>
      )}
    </Stack>
  );
}

function sourceTone(row: CommandRow): 'neutral' | 'success' | 'info' {
  if (row.source === 'skill') return 'success';
  if (row.source === 'plugin') return 'info';
  return 'neutral';
}
