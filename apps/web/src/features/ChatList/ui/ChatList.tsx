import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { VirtualList } from '@shared/ui/virtual-list';
import { useElementHeight } from '@shared/hooks/use-element-height';
import { useDebouncedValue } from '@shared/hooks/use-debounced-value';
import { useChatBodySearch, MIN_CHAT_SEARCH_LENGTH } from '@entities/Chat';
import { matchBodyHits, withGroupHeaders } from '../lib/rows';
import { ChatRow } from './ChatRow';
import { GROUP_HEIGHT, ROW_HEIGHT } from './ChatList.constants';
import type { ChatListProps, ChatRowData, ChatSearchMode } from './ChatList.types';
import styles from './ChatList.module.scss';

/**
 * Список разговоров. Сюда попадает вся история Claude Code, включая работу из
 * терминала и редактора, поэтому чатов сотни — список виртуализирован. Искать
 * можно двумя режимами: «по названию» (мгновенный фильтр по заголовку, проекту и
 * превью) и «по сообщениям» (полнотекстовый поиск по телу переписки на сервере,
 * со сниппетом вокруг совпадения). Результаты поиска по телу — те же строки
 * списка, поэтому клик по ним открывает разговор ровно как обычно.
 */
export function ChatList({
  chats,
  isLoading,
  activeId,
  onSelect,
  onCreate,
  statuses,
}: ChatListProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ChatSearchMode>('title');
  // Список занимает всю оставшуюся высоту, а виртуализации нужно число.
  const { ref, height } = useElementHeight<HTMLDivElement>(560);

  // Поиск по телу бьёт в сервер, поэтому ввод дебаунсим и запускаем только в
  // режиме «по сообщениям» — в режиме названия хук отключён (пустой запрос).
  const debounced = useDebouncedValue(query);
  const bodyQuery = mode === 'messages' ? debounced.trim() : '';
  const bodySearch = useChatBodySearch(bodyQuery);
  const isBodyReady = bodyQuery.length >= MIN_CHAT_SEARCH_LENGTH;

  const found = useMemo<ChatRowData[]>(() => {
    if (mode === 'messages') return matchBodyHits(chats, bodySearch.data?.hits);

    const needle = query.trim().toLowerCase();
    const matched = needle
      ? chats.filter(
          (chat) =>
            chat.title.toLowerCase().includes(needle) ||
            chat.project.toLowerCase().includes(needle) ||
            (chat.preview ?? '').toLowerCase().includes(needle),
        )
      : chats;

    // Порядок задаём и здесь, а не только на сервере: список всегда идёт от
    // свежего к старому, что бы ни пришло с бэкенда.
    return [...matched]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((chat) => ({ chat }));
  }, [chats, query, mode, bodySearch.data]);

  // Заголовки групп идут строками того же списка — иначе виртуализация и
  // разбивка по датам мешали бы друг другу.
  const rows = useMemo(() => withGroupHeaders(found), [found]);

  const showSkeleton = isLoading || (mode === 'messages' && isBodyReady && bodySearch.isLoading);
  const searchNeedle = mode === 'messages' ? bodyQuery : '';

  return (
    <Stack className={styles.panel}>
      <Stack gap="var(--spacing-xs)" className={styles.header}>
        <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={onCreate}>
          {t('chat.newChat')}
        </Button>

        <SearchField
          label={t('chat.searchChats')}
          value={query}
          onChange={setQuery}
          placeholder={
            mode === 'messages' ? t('chat.searchInMessages') : t('chat.searchPlaceholder')
          }
        />

        <Stack
          direction="row"
          gap="var(--spacing-3xs)"
          role="tablist"
          aria-label={t('chat.searchMode')}
          className={styles.modes}
        >
          {(['title', 'messages'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={`${styles.modeButton} ${mode === value ? styles.modeActive : ''}`}
              onClick={() => setMode(value)}
            >
              {t(value === 'title' ? 'chat.searchByTitle' : 'chat.searchByMessages')}
            </button>
          ))}
        </Stack>

        <Typography variant="caption" color="subtle">
          {mode === 'messages' && !isBodyReady
            ? t('chat.searchMessagesHint')
            : t('plugins.catalogCount', { found: found.length, total: chats.length })}
        </Typography>
      </Stack>

      <div className={styles.items} ref={ref}>
        {showSkeleton && <SkeletonList rows={6} withActions={false} />}

        <VirtualList
          items={rows}
          rowHeight={(row) => (row.kind === 'header' ? GROUP_HEIGHT : ROW_HEIGHT)}
          height={height}
          getKey={(row) => (row.kind === 'header' ? `group-${row.group}` : row.data.chat.id)}
          renderRow={(row) =>
            row.kind === 'header' ? (
              <Typography variant="caption" color="subtle" className={styles.group} as="div">
                {t(`chat.${row.group}`)}
              </Typography>
            ) : (
              <ChatRow
                chat={row.data.chat}
                isActive={row.data.chat.id === activeId}
                language={i18n.language}
                snippet={row.data.snippet}
                matchCount={row.data.matchCount}
                query={searchNeedle}
                status={statuses?.get(row.data.chat.id)}
                onSelect={() => onSelect(row.data.chat)}
              />
            )
          }
        />
      </div>
    </Stack>
  );
}
