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
import { formatDate } from '@shared/lib/format';
import type { ChatListProps, ChatRowProps } from './ChatList.types';
import styles from './ChatList.module.scss';

/**
 * Список разговоров. Сюда попадает вся история Claude Code, включая работу из
 * терминала и редактора, поэтому чатов сотни — список виртуализирован, а искать
 * можно и по названию, и по проекту, и по последней реплике.
 */
export function ChatList({ chats, isLoading, activeId, onSelect, onCreate }: ChatListProps) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  // Список занимает всю оставшуюся высоту, а виртуализации нужно число.
  const { ref, height } = useElementHeight<HTMLDivElement>(560);

  const found = useMemo(() => {
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
    return [...matched].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [chats, query]);

  // Заголовки групп идут строками того же списка — иначе виртуализация и
  // разбивка по датам мешали бы друг другу.
  const rows = useMemo(() => withGroupHeaders(found), [found]);

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
          placeholder={t('chat.searchPlaceholder')}
        />

        <Typography variant="caption" color="subtle">
          {t('plugins.catalogCount', { found: found.length, total: chats.length })}
        </Typography>
      </Stack>

      <div className={styles.items} ref={ref}>
        {isLoading && <SkeletonList rows={6} withActions={false} />}

        <VirtualList
          items={rows}
          rowHeight={(row) => (row.kind === 'header' ? GROUP_HEIGHT : ROW_HEIGHT)}
          height={height}
          getKey={(row) => (row.kind === 'header' ? `group-${row.group}` : row.chat.id)}
          renderRow={(row) =>
            row.kind === 'header' ? (
              <Typography variant="caption" color="subtle" className={styles.group} as="div">
                {t(`chat.${row.group}`)}
              </Typography>
            ) : (
              <ChatRow
                chat={row.chat}
                isActive={row.chat.id === activeId}
                language={i18n.language}
                onSelect={() => onSelect(row.chat)}
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

type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

type Row =
  { kind: 'header'; group: TimeGroup } | { kind: 'chat'; chat: ChatSummary; group: TimeGroup };

/** Раскладывает отсортированный список по группам «Сегодня / Вчера / …». */
function withGroupHeaders(chats: ChatSummary[]): Row[] {
  const rows: Row[] = [];
  let current: TimeGroup | undefined;

  for (const chat of chats) {
    const group = timeGroup(chat.updatedAt);
    if (group !== current) {
      rows.push({ kind: 'header', group });
      current = group;
    }
    rows.push({ kind: 'chat', chat, group });
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

function ChatRow({ chat, isActive, language, onSelect }: ChatRowProps) {
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

        <Typography variant="caption" color="subtle" className={styles.preview}>
          {chat.isSandbox ? t('chat.sandboxLabel') : projectName(chat)}
        </Typography>

        <Stack direction="row" align="center" gap="var(--spacing-3xs)">
          <Typography variant="caption" color="subtle" as="span">
            {formatWhen(chat.updatedAt, language, t)}
          </Typography>
          <span className={styles.dot}>·</span>
          {/* Иконка снимает догадку: число рядом с ней читается как «сообщений». */}
          <Icon name="chat" size={14} />
          <Typography variant="caption" color="subtle" as="span">
            {chat.messageCount}
          </Typography>
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
