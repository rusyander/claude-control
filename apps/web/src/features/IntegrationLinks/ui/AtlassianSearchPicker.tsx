import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { SearchField } from '@shared/ui/search-field';
import { toErrorMessage } from '@shared/api/client';
import { useConfluenceSearch, useJiraSearch } from '@entities/Integration';
import type { AtlassianSearchPickerProps } from './AtlassianSearchPicker.types';
import styles from './IntegrationLinks.module.scss';

/**
 * Поиск по Jira или Confluence с выбором одного объекта.
 *
 * Запрос уходит по нажатию, а не по каждой букве: это ЧУЖОЙ сервис за сетью, и
 * поиск-на-лету превратил бы набор из десяти символов в десять запросов к
 * трекеру команды. Введённое остаётся в поле, а искомое фиксируется отдельно —
 * поэтому список не мигает, пока строку правят.
 *
 * Ошибка показывается текстом сервера: «интеграция не настроена» и «токен
 * отклонён» — разные причины пустого списка, и общее «ничего не найдено» здесь
 * было бы враньём.
 */
export function AtlassianSearchPicker({
  kind,
  chosen,
  onChoose,
  onClear,
}: AtlassianSearchPickerProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');

  const jira = useJiraSearch(kind === 'jira' ? query : '');
  const confluence = useConfluenceSearch(kind === 'confluence' ? query : '');
  const source = kind === 'jira' ? jira : confluence;

  const rows =
    kind === 'jira'
      ? (jira.data ?? []).map((issue) => ({
          id: issue.key,
          title: issue.summary,
          badge: issue.status,
        }))
      : (confluence.data ?? []).map((page) => ({
          id: page.id,
          title: page.title,
          badge: page.spaceKey,
        }));

  return (
    <Stack gap="var(--spacing-xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center">
        <Stack flex={1} minWidth="200px">
          <SearchField
            label={t(`integrations.picker.${kind}.search`)}
            placeholder={t(`integrations.picker.${kind}.placeholder`)}
            value={text}
            onChange={setText}
          />
        </Stack>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="search" size={18} />}
          onClick={() => setQuery(text.trim())}
          disabled={!text.trim()}
          isLoading={source.isFetching}
        >
          {t('integrations.picker.find')}
        </Button>
      </Stack>

      {chosen && (
        <Stack direction="row" gap="var(--spacing-2xs)" align="center" wrap>
          <Badge tone="accent">{t('integrations.picker.chosen')}</Badge>
          <Typography variant="body-sm" as="span">
            {chosen}
          </Typography>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="close" size={16} />}
            aria-label={t('integrations.picker.clear')}
            onClick={onClear}
          />
        </Stack>
      )}

      {source.isError && (
        <Typography variant="caption" color="danger">
          {toErrorMessage(source.error)}
        </Typography>
      )}

      {query && !source.isFetching && !source.isError && rows.length === 0 && (
        <Typography variant="caption" color="subtle">
          {t('integrations.picker.nothing')}
        </Typography>
      )}

      {rows.length > 0 && (
        <Card padding="sm">
          <Stack gap="var(--spacing-3xs)" className={styles.results}>
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className={styles.resultRow}
                onClick={() => onChoose(row.id, row.title)}
              >
                <Badge tone="neutral">{row.badge}</Badge>
                <Typography variant="body-sm" as="span" truncate>
                  {kind === 'jira' ? `${row.id} · ${row.title}` : row.title}
                </Typography>
              </button>
            ))}
          </Stack>
        </Card>
      )}
    </Stack>
  );
}
