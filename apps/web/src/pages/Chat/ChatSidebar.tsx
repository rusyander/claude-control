import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { ChatList } from '@features/ChatList';
import { ProjectList } from '@features/ProjectList';
import type { ChatSidebarProps, HomeSection } from './ChatSidebar.types';
import styles from './ChatPage.module.scss';

/**
 * Левая колонка чата. На домашнем табе переключается между списком разговоров
 * песочницы и списком проектов; внутри проекта — только его разговоры.
 */
export function ChatSidebar({
  isHome,
  chats,
  isChatsLoading,
  activeChatId,
  chatStatuses,
  onSelectChat,
  onCreateChat,
  projects,
  isProjectsLoading,
  activeProjectId,
  projectStatuses,
  onOpenProject,
  onAddFolder,
  onParallelLaunch,
}: ChatSidebarProps) {
  const { t } = useTranslation();
  const [homeSection, setHomeSection] = useState<HomeSection>('chats');

  return (
    <div className={styles.sidebar}>
      {isHome && (
        <Stack
          direction="row"
          gap="var(--spacing-3xs)"
          padding="var(--spacing-2xs)"
          role="tablist"
          aria-label={t('projects.sidebarLabel')}
          className={styles.segment}
        >
          <button
            type="button"
            role="tab"
            aria-selected={homeSection === 'chats'}
            className={`${styles.segmentButton} ${homeSection === 'chats' ? styles.segmentActive : ''}`}
            onClick={() => setHomeSection('chats')}
          >
            {t('chat.title')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={homeSection === 'projects'}
            className={`${styles.segmentButton} ${homeSection === 'projects' ? styles.segmentActive : ''}`}
            onClick={() => setHomeSection('projects')}
          >
            {t('projects.title')}
          </button>
        </Stack>
      )}

      <div className={styles.sidebarList}>
        {isHome && homeSection === 'projects' ? (
          <ProjectList
            projects={projects}
            isLoading={isProjectsLoading}
            activeId={activeProjectId}
            statuses={projectStatuses}
            onOpen={onOpenProject}
            onAddFolder={onAddFolder}
            onParallelLaunch={onParallelLaunch}
          />
        ) : (
          <ChatList
            chats={chats}
            isLoading={isChatsLoading}
            activeId={activeChatId}
            statuses={chatStatuses}
            onSelect={onSelectChat}
            onCreate={onCreateChat}
          />
        )}
      </div>
    </div>
  );
}
