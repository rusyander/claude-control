import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ChatArtifactsBarProps } from './ChatArtifactsBar.types';
import styles from './ChatPage.module.scss';

/** Полоса артефактов разговора: открыть предпросмотр или удалить файл. */
export function ChatArtifactsBar({ artifacts, onPreview, onDelete }: ChatArtifactsBarProps) {
  const { t } = useTranslation();

  if (artifacts.length === 0) return null;

  return (
    <Stack
      direction="row"
      wrap
      gap="var(--spacing-2xs)"
      padding="var(--spacing-2xs) var(--spacing-xl)"
      data-artifacts
      className={styles.artifacts}
    >
      {artifacts.map((artifact) => (
        <Stack
          key={artifact.name}
          direction="row"
          align="center"
          gap="var(--spacing-3xs)"
          className={styles.artifactChip}
        >
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<Icon name="file" size={20} />}
            onClick={() => onPreview(artifact)}
          >
            {artifact.name}
          </Button>
          {/* Удаление доступно только у чатов песочницы — их артефакты
              возвращает сервер; у проекта список пуст, и кнопки нет. */}
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="trash" size={18} />}
            aria-label={t('chat.deleteArtifact', { name: artifact.name })}
            onClick={() => onDelete(artifact)}
          />
        </Stack>
      ))}
    </Stack>
  );
}
