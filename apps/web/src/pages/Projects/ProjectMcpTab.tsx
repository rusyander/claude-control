import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer } from '@agentdeck/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProjectMcp, useDeleteProjectMcp, useSetProjectMcpEnabled } from '@entities/Project';
import { ProjectMcpCard } from './ProjectMcpCard';
import { ProjectMcpForm } from './ProjectMcpForm';
import { SourceLine } from './SourceLine';
import { projectFilePath } from './lib/projectFilePath';
import type { ProjectFileTabProps } from './ProjectRulesTab.types';
import styles from './ProjectsPage.module.scss';

/** MCP-серверы проекта из его корневого `.mcp.json` — правятся здесь. */
export function ProjectMcpTab({ projectId, projectPath }: ProjectFileTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<McpServer | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: servers = [], isLoading } = useProjectMcp(projectId);
  const deleteServer = useDeleteProjectMcp(projectId);
  const setEnabled = useSetProjectMcpEnabled(projectId);

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (server: McpServer): void => {
    setEditing(server);
    setIsFormOpen(true);
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <div className={styles.sectionHead}>
        <div className={styles.sectionText}>
          <SourceLine isEditable path={projectFilePath(projectPath, '.mcp.json')} />
          <Typography variant="caption" color="subtle" className={styles.sectionHint}>
            {t('projectsPage.hint.mcp')}
          </Typography>
        </div>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="plus" size={20} />}
          onClick={openCreate}
        >
          {t('projectConfig.addMcp')}
        </Button>
      </div>

      {isLoading && <SkeletonList rows={3} />}

      {servers.map((server) => (
        <ProjectMcpCard
          key={server.id}
          server={server}
          onToggle={(isEnabled) => setEnabled.mutate({ id: server.id, isEnabled })}
          onEdit={() => openEdit(server)}
          onDelete={() => deleteServer.mutate(server.id)}
          isDeleting={deleteServer.isPending}
        />
      ))}

      {!isLoading && servers.length === 0 && (
        <Typography color="subtle">{t('projectConfig.mcpEmpty')}</Typography>
      )}

      <ProjectMcpForm
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        projectId={projectId}
        server={editing}
      />
    </Stack>
  );
}
