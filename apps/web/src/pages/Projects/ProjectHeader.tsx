import { useTranslation } from 'react-i18next';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import { IntegrationLinksBar } from '@features/IntegrationLinks';
import type { ProjectHeaderProps } from './ProjectHeader.types';
import styles from './ProjectsPage.module.scss';

/**
 * Шапка выбранного проекта: имя, корень и то, что относится к проекту целиком, —
 * внешние привязки и «убрать из списка».
 *
 * Удаление живёт здесь, а не корзиной у каждой строки реестра: разрушительное
 * действие стоит у того, что оно удаляет, и не соседствует с выбором проекта.
 * Метки «проектный уровень» больше нет — вся страница проектная, и метка
 * ничего не различала.
 */
export function ProjectHeader({ project, providerName, onRemove, isRemoving }: ProjectHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className={styles.projectHeader}>
      <div className={styles.projectTitleRow}>
        <Icon name="folder" size={20} />
        <Typography variant="heading-sm" as="h2" className={styles.projectTitle}>
          {project.name}
        </Typography>
        {providerName && <Badge tone="neutral">{providerName}</Badge>}
        <DeleteButton
          entityName={project.name}
          description={t('projectConfig.removeDescription')}
          onDelete={onRemove}
          isPending={isRemoving}
        />
      </div>

      {/* Внешний контекст проекта не в его файлах, а в панели — поэтому стоит
          рядом с корнем, а не среди вкладок конфигурации. */}
      <div className={styles.projectMeta}>
        <Typography variant="mono" color="subtle" as="span" className={styles.projectRoot}>
          {project.path}
        </Typography>
        <IntegrationLinksBar projectPath={project.path} />
      </div>
    </header>
  );
}
