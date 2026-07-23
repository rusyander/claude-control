import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { useProjectMcp, useDeleteProjectMcp, useSetProjectMcpEnabled } from '@entities/Project';
import { ProjectMcpCard } from './ProjectMcpCard';
import { ProjectMcpForm } from './ProjectMcpForm';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/** MCP-серверы проекта из его корневого `.mcp.json`. */
export function ProjectMcpTab({ projectId }: ProjectTabProps) {
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
      <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
        <Typography variant="caption" color="subtle">
          {t('projectConfig.mcpHint')}
        </Typography>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Icon name="plus" size={20} />}
          onClick={openCreate}
        >
          {t('projectConfig.addMcp')}
        </Button>
      </Stack>

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
