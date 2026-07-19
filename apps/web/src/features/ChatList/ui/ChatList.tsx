import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import type { ChatListProps } from './ChatList.types';
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
    if (!needle) return chats;

    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(needle) ||
        chat.project.toLowerCase().includes(needle) ||
        (chat.preview ?? '').toLowerCase().includes(needle),
    );
  }, [chats, query]);

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
          items={found}
          rowHeight={100}
          height={height}
          getKey={(chat) => chat.id}
          renderRow={(chat) => (
            <ChatRow
              chat={chat}
              isActive={chat.id === activeId}
              language={i18n.language}
              onSelect={() => onSelect(chat)}
            />
          )}
        />
      </div>
    </Stack>
  );
}

interface ChatRowProps {
  chat: ChatSummary;
  isActive: boolean;
  language: string;
  onSelect: () => void;
}

function ChatRow({ chat, isActive, language, onSelect }: ChatRowProps) {
  return (
    <button
      type="button"
      className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
      onClick={onSelect}
    >
      <Stack gap="var(--spacing-3xs)">
        <Typography variant="body-sm" weight="medium" className={styles.title}>
          {chat.title}
        </Typography>

        <Typography variant="caption" color="subtle" className={styles.preview}>
          {chat.project}
        </Typography>

        <Typography variant="caption" color="subtle" as="span">
          {formatDate(chat.updatedAt, language)} · {chat.messageCount}
        </Typography>
      </Stack>
    </button>
  );
}
