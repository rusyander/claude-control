import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ChatSummary } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SearchField } from '@shared/ui/search-field';
import { VirtualList } from '@shared/ui/virtual-list';
import { useElementHeight } from '@shared/hooks/use-element-height';
import { useDebouncedValue } from '@shared/hooks/use-debounced-value';
import { formatDate } from '@shared/lib/format';
import { useChatBodySearch, MIN_CHAT_SEARCH_LENGTH } from '@entities/Chat';
import { highlightSnippet } from '../model/highlight';
import type { ChatListProps, ChatRowProps, ChatSearchMode } from './ChatList.types';
import styles from './ChatList.module.scss';

/**
 * Список разговоров. Сюда попадает вся история Claude Code, включая работу из
 * терминала и редактора, поэтому чатов сотни — список виртуализирован. Искать
 * можно двумя режимами: «по названию» (мгновенный фильтр по заголовку, проекту и
 * превью) и «по сообщениям» (полнотекстовый поиск по телу переписки на сервере,
 * со сниппетом вокруг совпадения). Результаты поиска по телу — те же строки
 * списка, поэтому клик по ним открывает разговор ровно как обычно.
 */
export function ChatList({ chats, isLoading, activeId, onSelect, onCreate }: ChatListProps) {
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
                onSelect={() => onSelect(row.data.chat)}
              />
            )
          }
        />
      </div>
    </Stack>
  );
}

const ROW_HEIGHT = 100;
const GROUP_HEIGHT = 32;

/** Строка списка: разговор и, для поиска по телу, его сниппет с числом совпадений. */
interface ChatRowData {
  chat: ChatSummary;
  snippet?: string;
  matchCount?: number;
}

type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

type Row =
  { kind: 'header'; group: TimeGroup } | { kind: 'chat'; group: TimeGroup; data: ChatRowData };

/**
 * Совпадения по телу приходят глобально; показываем из них только те, что есть
 * в видимом списке (он уже ограничен вкладкой), и переносим на строки сниппет с
 * числом совпадений. Порядок — от свежего к старому, как и в обычном списке.
 */
function matchBodyHits(
  chats: ChatSummary[],
  hits: { sessionId: string; snippet: string; matchCount: number }[] | undefined,
): ChatRowData[] {
  if (!hits || hits.length === 0) return [];

  const bySession = new Map(hits.map((hit) => [hit.sessionId, hit]));

  return chats
    .filter((chat) => bySession.has(chat.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((chat) => {
      const hit = bySession.get(chat.id);
      return { chat, snippet: hit?.snippet, matchCount: hit?.matchCount };
    });
}

/** Раскладывает отсортированный список по группам «Сегодня / Вчера / …». */
function withGroupHeaders(items: ChatRowData[]): Row[] {
  const rows: Row[] = [];
  let current: TimeGroup | undefined;

  for (const data of items) {
    const group = timeGroup(data.chat.updatedAt);
    if (group !== current) {
      rows.push({ kind: 'header', group });
      current = group;
    }
    rows.push({ kind: 'chat', group, data });
  }

  return rows;
}

function timeGroup(iso: string): TimeGroup {
  const date = new Date(iso);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  if (date.getTime() >= startOfToday.getTime()) return 'today';

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date.getTime() >= startOfYesterday.getTime()) return 'yesterday';

  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 7);
  return date.getTime() >= weekAgo.getTime() ? 'thisWeek' : 'earlier';
}

function ChatRow({ chat, isActive, language, onSelect, snippet, matchCount, query }: ChatRowProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
      onClick={onSelect}
      title={chat.projectPath || chat.project}
    >
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" className={styles.title}>
          {chat.title}
        </Typography>

        {snippet ? (
          <Typography variant="caption" color="subtle" className={styles.preview} as="div">
            {highlightSnippet(snippet, query ?? '').map((part, index) =>
              part.match ? (
                <mark key={index} className={styles.mark}>
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              ),
            )}
          </Typography>
        ) : (
          <Typography variant="caption" color="subtle" className={styles.preview}>
            {chat.isSandbox ? t('chat.sandboxLabel') : projectName(chat)}
          </Typography>
        )}

        <Stack direction="row" align="center" gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {formatWhen(chat.updatedAt, language, t)}
          </Typography>
          <span className={styles.dot}>·</span>
          {/* Иконка снимает догадку: число рядом с ней читается как «сообщений». */}
          <Icon name="chat" size={14} />
          {/* «+» у длинного разговора: список читает большой транскрипт началом
              и хвостом, поэтому точного итога у него нет — и выдавать неполное
              число за итог нечестно. Пояснение — в подсказке. */}
          <Typography
            variant="caption"
            color="subtle"
            as="span"
            title={chat.messageCountPartial ? t('chat.messageCountPartial') : undefined}
          >
            {chat.messageCount}
            {chat.messageCountPartial ? '+' : ''}
          </Typography>
          {matchCount !== undefined && (
            <>
              <span className={styles.dot}>·</span>
              <Icon name="search" size={14} />
              <Typography variant="caption" color="subtle" as="span">
                {matchCount}
              </Typography>
            </>
          )}
        </Stack>
      </Stack>
    </button>
  );
}

/** Имя проекта: из пути читается лучше, чем закодированное имя папки. */
function projectName(chat: ChatSummary): string {
  const fromPath = chat.projectPath.split(/[\\/]/).filter(Boolean).pop();
  return fromPath || chat.project;
}

/**
 * Когда в чате последний раз говорили. Внутри часа — минуты, сегодня и вчера —
 * время, дальше — дата. Голая дата, как было раньше, у сегодняшних чатов
 * одинаковая, и понять порядок списка по ней невозможно.
 */
function formatWhen(iso: string, language: string, t: TFunction): string {
  const date = new Date(iso);
  const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);

  if (minutes < 1) return t('chat.justNow');
  if (minutes < 60) return t('chat.minutesAgo', { count: minutes });

  const time = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  const group = timeGroup(iso);

  if (group === 'today') return time;
  if (group === 'yesterday') return `${t('chat.yesterday')}, ${time}`;

  return formatDate(iso, language);
}
