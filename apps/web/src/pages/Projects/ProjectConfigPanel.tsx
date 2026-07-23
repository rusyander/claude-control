import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { ProjectRulesTab } from './ProjectRulesTab';
import { ProjectMcpTab } from './ProjectMcpTab';
import { ProjectPermissionsTab } from './ProjectPermissionsTab';
import type { ProjectConfigPanelProps, ProjectTab } from './ProjectConfigPanel.types';
import styles from './ProjectsPage.module.scss';

const TABS: ProjectTab[] = ['rules', 'mcp', 'permissions'];

/**
 * Конфиг выбранного проекта: заголовок с путём и бейджем «проектный уровень» и
 * разделы — правила (CLAUDE.md), MCP-серверы (.mcp.json) и права
 * (.claude/settings.json). Разделы переключаются табами.
 */
export function ProjectConfigPanel({ project }: ProjectConfigPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ProjectTab>('rules');

  return (
    <Stack gap="var(--spacing-md)">
      <Stack gap="var(--spacing-2xs)">
        <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
          <Icon name="folder" size={20} />
          <Typography variant="heading-sm" as="h2">
            {project.name}
          </Typography>
          <Badge tone="accent">{t('projectConfig.levelBadge')}</Badge>
        </Stack>
        <Typography variant="mono" color="subtle" as="span" truncate>
          {project.path}
        </Typography>
      </Stack>

      <Stack direction="row" gap="var(--spacing-2xs)" wrap className={styles.tabs}>
        {TABS.map((value) => (
          <Button
            key={value}
            variant={tab === value ? 'primary' : 'secondary'}
            onClick={() => setTab(value)}
          >
            {t(`projectConfig.tab_${value}`)}
          </Button>
        ))}
      </Stack>

      {tab === 'rules' && <ProjectRulesTab projectId={project.id} />}
      {tab === 'mcp' && <ProjectMcpTab projectId={project.id} />}
      {tab === 'permissions' && <ProjectPermissionsTab projectId={project.id} />}
    </Stack>
  );
}
