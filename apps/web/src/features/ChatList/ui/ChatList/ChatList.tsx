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
import { useChatBodySearch, useChats, usePinChat, MIN_CHAT_SEARCH_LENGTH } from '@entities/Chat';
import { escalationsOf, useChatEscalations } from '@entities/ChatGroupSettings';
import { matchBodyHits } from '../../lib/rows';
import { searchView } from '../../lib/searchView';
import { useExpandedBranches } from '../../model/expandedBranches';
import { ChatRow } from '../ChatRow/ChatRow';
import type { ChatListProps, ChatRowData, ChatSearchMode } from './ChatList.types';
import styles from './ChatList.module.scss';
import { rowKey } from '../../lib/rowKey';
import { chatListRows } from '../../lib/chatListRows';
import { groupLabel } from '../../lib/groupLabel';
import { rowHeight } from '../../lib/rowHeight';

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
  const view = searchView({ mode, query, bodyQuery, minLength: MIN_CHAT_SEARCH_LENGTH });
  // Непрочитанное критичное от детей разделения — метка у главного чата дерева.
  const escalations = useChatEscalations();
  // Все разговоры на диске, а не только этой вкладки: по ним сирота отличает
  // «родитель удалён» от «родитель в другом проекте».
  const everything = useChats();
  const known = useMemo(
    () => (everything.data ? new Set(everything.data.map((chat) => chat.id)) : undefined),
    [everything.data],
  );
  const pinChat = usePinChat();

  const found = useMemo<ChatRowData[]>(() => {
    if (view.useBodyHits) return matchBodyHits(chats, bodySearch.data?.hits);

    // В режиме «По сообщениям» короткий или пустой запрос — весь список, а не
    // фильтр по названию: этот режим названия не ищет.
    const needle = mode === 'title' ? query.trim().toLowerCase() : '';
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
  }, [chats, query, mode, view.useBodyHits, bodySearch.data]);

  // Заголовки групп идут строками того же списка — иначе виртуализация и
  // разбивка по датам мешали бы друг другу. Дерево строится ДО заголовков:
  // ветвь обязана остаться под своим корнем, а не уехать в свою дату.
  //
  // Идущие ветви — над датами (владелец, 24.09.2026): за работающим агентом
  // следят, и искать его среди вчерашних разговоров не должно быть нужно.
  // «Идёт» — живой прогон, в том числе замолчавший, или разделение в работе
  // (`inWork`: между стадиями группы прогона нет, а работа идёт). Вопрос из
  // транскрипта (жёлтая точка без прогона) наверх не поднимает: такие висят и
  // неделями.
  //
  // Не идущие дети ветви свёрнуты в гармошку «Ещё N» (G1); раскрытое помнится
  // на родителя. Пока идёт поиск, гармошек нет: найденное обязано быть видно.
  const { expanded, toggle } = useExpandedBranches();
  const searching = view.useBodyHits || (mode === 'title' && query.trim().length > 0);
  const rows = useMemo(
    () => chatListRows(found, statuses, { expanded, searching, known }),
    [found, statuses, expanded, searching, known],
  );

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
          {view.showHint
            ? t('chat.searchMessagesHint')
            : t('plugins.catalogCount', { found: found.length, total: chats.length })}
        </Typography>
      </Stack>

      <div className={styles.items} ref={ref}>
        {showSkeleton && <SkeletonList rows={6} withActions={false} />}

        <VirtualList
          items={rows}
          rowHeight={rowHeight}
          height={height}
          getKey={rowKey}
          renderRow={(row) => {
            if (row.kind === 'header') {
              return (
                <Typography variant="caption" color="subtle" className={styles.group} as="div">
                  {t(groupLabel(row.group))}
                </Typography>
              );
            }
            if (row.kind === 'more') {
              return (
                <button
                  type="button"
                  className={styles.more}
                  aria-expanded={row.expanded}
                  title={t(row.expanded ? 'chat.branchFoldHint' : 'chat.branchUnfoldHint')}
                  data-chat-more={row.parentId}
                  onClick={() => toggle(row.parentId)}
                >
                  <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={14} />
                  {t('chat.branchMore', { count: row.count })}
                </button>
              );
            }
            if (row.kind === 'inactive') {
              return (
                <Typography variant="caption" color="subtle" className={styles.inactive} as="div">
                  {t('chat.inactiveBranch')}
                </Typography>
              );
            }
            if (row.data.lostParent) {
              return (
                <div
                  className={styles.lostParent}
                  title={t('chat.lostParentHint')}
                  data-chat-lost-parent={row.data.chat.id}
                >
                  <Stack gap="var(--spacing-3xs)">
                    <Typography variant="body-sm" weight="medium" className={styles.title}>
                      {t('chat.lostParent')}
                    </Typography>
                    <Typography variant="caption" color="subtle" className={styles.preview}>
                      {t('chat.lostParentNote')}
                    </Typography>
                  </Stack>
                </div>
              );
            }
            const { chat } = row.data;
            return (
              <ChatRow
                chat={row.data.chat}
                isActive={row.data.chat.id === activeId}
                language={i18n.language}
                snippet={row.data.snippet}
                matchCount={row.data.matchCount}
                query={searchNeedle}
                status={statuses?.get(row.data.chat.id)}
                depth={row.data.depth}
                unreadEscalations={
                  escalationsOf(escalations.data, [row.data.chat.id]).filter((entry) => !entry.read)
                    .length
                }
                onSelect={() => onSelect(row.data.chat)}
                {...(row.data.depth
                  ? {}
                  : {
                      onTogglePin: () =>
                        pinChat.mutate({ chatId: chat.id, pinned: !chat.pinnedAt }),
                    })}
              />
            );
          }}
        />
      </div>
    </Stack>
  );
}
