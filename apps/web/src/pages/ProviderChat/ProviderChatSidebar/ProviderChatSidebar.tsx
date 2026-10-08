import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Skeleton } from '@shared/ui/skeleton';
import { TabButton } from '@shared/ui/tab-button';
import { ProviderChatProjects } from '../ProviderChatProjects/ProviderChatProjects';
import type {
  ProviderChatSidebarProps,
  ProviderChatSidebarSection,
} from './ProviderChatSidebar.types';
import styles from './ProviderChatSidebar.module.scss';

/**
 * Левая колонка: разговоры активного провайдера, свежие сверху, — и вкладка
 * «Проекты» со всеми каталогами, где работал любой CLI. Без неё при смене
 * провайдера проекты, начатые с Claude, из чата пропадали.
 */
export function ProviderChatSidebar({
  chats,
  isLoading,
  activeChatId,
  onSelect,
  onCreate,
  isCreating,
  projects,
  isProjectsLoading,
  providerId,
  providerName,
  onStartInProject,
}: ProviderChatSidebarProps) {
  const { t } = useTranslation();
  const [section, setSection] = useState<ProviderChatSidebarSection>('chats');

  // Новый разговор в проекте открывается в ленте — и список рядом с ним должен
  // быть списком разговоров, где он теперь первый.
  const startInProject = (path: string): void => {
    onStartInProject(path);
    setSection('chats');
  };

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
        <Stack direction="row" gap="var(--spacing-3xs)">
          <TabButton isActive={section === 'chats'} onClick={() => setSection('chats')}>
            {t('providerChat.conversations')}
          </TabButton>
          <TabButton isActive={section === 'projects'} onClick={() => setSection('projects')}>
            {t('providerChat.projectsTab')}
          </TabButton>
        </Stack>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onCreate();
            setSection('chats');
          }}
          isLoading={isCreating}
          leftIcon={<Icon name="plus" size={16} />}
        >
          {t('providerChat.new')}
        </Button>
      </Stack>

      <div className={styles.sidebarList}>
        {section === 'projects' && (
          <ProviderChatProjects
            projects={projects}
            isLoading={isProjectsLoading}
            providerId={providerId}
            providerName={providerName}
            onStart={startInProject}
            isStarting={isCreating}
          />
        )}

        {section === 'chats' && isLoading && (
          <Stack gap="var(--spacing-3xs)">
            <Skeleton height={38} />
            <Skeleton height={38} />
            <Skeleton height={38} />
          </Stack>
        )}

        {section === 'chats' && !isLoading && chats.length === 0 && (
          <Stack padding="var(--spacing-xs)">
            <Typography variant="caption" color="subtle">
              {t('providerChat.noConversations')}
            </Typography>
          </Stack>
        )}

        {section === 'chats' && !isLoading && chats.length > 0 && (
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
