import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Icon } from '@shared/ui/icon';
import { PROJECT_ACTIONS, SUGGESTIONS } from './ChatPage.constants';
import type { ChatEmptyStateProps } from './ChatEmptyState.types';
import styles from './ChatPage.module.scss';

/**
 * Пустой чат: вместо пустоты — куда попал и с чего начать. В проекте это его
 * путь и быстрые действия по коду, в песочнице — общие примеры запросов.
 */
export function ChatEmptyState({
  isProjectContext,
  projectName,
  projectPath,
  onOpenEditor,
  onPick,
}: ChatEmptyStateProps) {
  const { t } = useTranslation();

  return (
    <Stack
      direction="row"
      flex={1}
      align="center"
      justify="center"
      padding="var(--spacing-xl)"
      className={styles.empty}
    >
      <Stack gap="var(--spacing-sm)" align="center" className={styles.emptyBox}>
        <Icon name={isProjectContext ? 'folder' : 'chat'} size={40} />
        <Typography variant="heading-sm">
          {isProjectContext ? (projectName ?? t('chat.newChat')) : t('chat.emptyTitle')}
        </Typography>

        {isProjectContext ? (
          <>
            <Typography as="span" className={styles.projectIntro}>
              {projectPath}
            </Typography>
            <Typography color="muted" className={styles.emptyText}>
              {t('projects.introHint')}
            </Typography>
            <Stack
              direction="row"
              wrap
              justify="center"
              gap="var(--spacing-2xs)"
              marginTop="var(--spacing-xs)"
            >
              {projectPath && (
                <button
                  type="button"
                  className={`${styles.suggestion} ${styles.suggestionAction}`}
                  onClick={() => onOpenEditor(projectPath)}
                >
                  <Icon name="scripts" size={16} />
                  {t('projects.openInEditor')}
                </button>
              )}
              {PROJECT_ACTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => onPick(t(`projects.actions.${key}`))}
                >
                  {t(`projects.actions.${key}`)}
                </button>
              ))}
            </Stack>
          </>
        ) : (
          <>
            <Typography color="muted" className={styles.emptyText}>
              {t('chat.emptyText')}
            </Typography>
            <Stack
              direction="row"
              wrap
              justify="center"
              gap="var(--spacing-2xs)"
              marginTop="var(--spacing-xs)"
            >
              {SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => onPick(t(`chat.suggestions.${key}`))}
                >
                  {t(`chat.suggestions.${key}`)}
                </button>
              ))}
            </Stack>
          </>
        )}
      </Stack>
    </Stack>
  );
}
