import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Skeleton } from '@shared/ui/skeleton';
import type { ProviderChatSidebarProps } from './ProviderChatSidebar.types';
import styles from './ProviderChatPage.module.scss';

/** Левая колонка: разговоры активного провайдера, свежие сверху. */
export function ProviderChatSidebar({
  chats,
  isLoading,
  activeChatId,
  onSelect,
  onCreate,
  isCreating,
}: ProviderChatSidebarProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.sidebar}>
      <Stack
        direction="row"
        align="center"
        justify="between"
        gap="var(--spacing-2xs)"
        padding="var(--spacing-2xs) var(--spacing-xs)"
        className={styles.sidebarHead}
      >
        <Typography variant="body-sm" weight="medium">
          {t('providerChat.conversations')}
        </Typography>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCreate}
          isLoading={isCreating}
          leftIcon={<Icon name="plus" size={16} />}
        >
          {t('providerChat.new')}
        </Button>
      </Stack>

      <div className={styles.sidebarList}>
        {isLoading && (
          <Stack gap="var(--spacing-3xs)">
            <Skeleton height={38} />
            <Skeleton height={38} />
            <Skeleton height={38} />
          </Stack>
        )}

        {!isLoading && chats.length === 0 && (
          <Stack padding="var(--spacing-xs)">
            <Typography variant="caption" color="subtle">
              {t('providerChat.noConversations')}
            </Typography>
          </Stack>
        )}

        {!isLoading && chats.length > 0 && (
          <Stack gap="2px">
            {chats.map((chat) => (
              <button
                key={chat.id}
                type="button"
                aria-current={chat.id === activeChatId}
                className={`${styles.chatItem} ${chat.id === activeChatId ? styles.chatItemActive : ''}`}
                onClick={() => onSelect(chat.id)}
              >
                <Typography variant="body-sm" as="span" className={styles.chatItemTitle}>
                  {chat.title}
                </Typography>
                <Typography variant="caption" color="subtle" as="span">
                  {t('providerChat.messageCount', { count: chat.messageCount })}
                </Typography>
              </button>
            ))}
          </Stack>
        )}
      </div>
    </div>
  );
}
