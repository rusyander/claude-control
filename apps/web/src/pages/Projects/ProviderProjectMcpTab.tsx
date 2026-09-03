import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UniversalMcpServer } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import {
  useProviderProjectMcp,
  useCreateProviderProjectMcp,
  useUpdateProviderProjectMcp,
  useDeleteProviderProjectMcp,
} from '@entities/Project';
import { ProviderMcpForm } from '@pages/ProviderMcp/ProviderMcpForm';
import type { ProjectTabProps } from './ProjectRulesTab.types';

/**
 * MCP-серверы проекта у активного провайдера: тот же переносимый субсет, что и в
 * глобальном разделе, но файл лежит В ПРОЕКТЕ (`.codex/config.toml`,
 * `.gemini/settings.json`, `opencode.json`, `.cursor/mcp.json`). Формат файла не
 * распознан → раздел только для чтения (запись запрещена, fail-closed).
 */
export function ProviderProjectMcpTab({ projectId }: ProjectTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<UniversalMcpServer | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data, isLoading } = useProviderProjectMcp(projectId, true);
  const createServer = useCreateProviderProjectMcp(projectId);
  const updateServer = useUpdateProviderProjectMcp(projectId);
  const deleteServer = useDeleteProviderProjectMcp(projectId);

  if (isLoading || !data) return <SkeletonList rows={3} />;

  const readOnly = data.readOnly;

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };
  const openEdit = (server: UniversalMcpServer): void => {
    setEditing(server);
    setIsFormOpen(true);
  };

  return (
    <Stack gap="var(--spacing-sm)">
      <Stack direction="row" justify="between" align="center" wrap gap="var(--spacing-sm)">
        <Stack gap="var(--spacing-3xs)" flex={1} minWidth={0}>
          <Typography variant="caption" color="subtle">
            {t('providerProject.mcpHint', { format: data.format })}
          </Typography>
          <Typography variant="mono" color="subtle" as="span" truncate>
            {data.filePath}
          </Typography>
        </Stack>
        {!readOnly && (
          <Button
            variant="primary"
            size="sm"
            leftIcon={<Icon name="plus" size={20} />}
            onClick={openCreate}
          >
            {t('mcp.addServer')}
          </Button>
        )}
      </Stack>

      {readOnly && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="warning" size={18} />
            <Typography variant="body-sm" color="warning">
              {t('providerMcp.readOnly', { path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

      {data.servers.map((server) => (
        <Card key={server.name} padding="md">
          <Stack
            direction="row"
            gap="var(--spacing-md)"
            align="start"
            justify="between"
            wrap
            width="100%"
          >
            <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
              <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
                <Typography variant="body" weight="medium" as="span">
                  {server.name}
                </Typography>
                <Badge tone="neutral">{server.transport}</Badge>
              </Stack>
              <Typography variant="mono" color="subtle" as="span" truncate>
                {server.command
                  ? `${server.command} ${server.args.join(' ')}`.trim()
                  : (server.url ?? '')}
              </Typography>
            </Stack>

            {!readOnly && (
              <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap justify="end">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon={<Icon name="edit" size={24} />}
                  aria-label={`${t('common.edit')}: ${server.name}`}
                  onClick={() => openEdit(server)}
                />
                <DeleteButton
                  entityName={server.name}
                  description={t('common.deleteMcp')}
                  onDelete={() => deleteServer.mutate(server.name)}
                  isPending={deleteServer.isPending}
                />
              </Stack>
            )}
          </Stack>
        </Card>
      ))}

      {data.servers.length === 0 && (
        <Typography color="subtle">{t('providerProject.mcpEmpty')}</Typography>
      )}

      <ProviderMcpForm
        isOpen={isFormOpen}
        providerName={data.providerName}
        onOpenChange={setIsFormOpen}
        server={editing}
        onSave={(draft, serverId, onDone) => {
          if (serverId) updateServer.mutate({ id: serverId, draft }, { onSuccess: onDone });
          else createServer.mutate(draft, { onSuccess: onDone });
        }}
        isPending={createServer.isPending || updateServer.isPending}
        isError={createServer.isError || updateServer.isError}
      />
    </Stack>
  );
}
