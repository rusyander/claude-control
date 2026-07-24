import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UniversalMcpServer } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { SkeletonList } from '@shared/ui/skeleton';
import { DeleteButton } from '@features/EntityDelete';
import {
  useProviderMcp,
  useDeleteProviderMcp,
  useCreateProviderMcp,
  useUpdateProviderMcp,
} from '@entities/ProviderMcp';
import { ProviderMcpForm } from './ProviderMcpForm';

/**
 * Универсальный раздел MCP-серверов для активного провайдера Gemini/Codex.
 * Базовый CRUD по переносимому субсету: список, добавить, править, удалить.
 * Заголовок и подсказки подстраиваются под провайдера и формат его файла. Если
 * формат файла не распознан — раздел только для чтения (запись запрещена).
 * Раздел Claude — отдельная богатая страница, сюда не попадает.
 */
export function ProviderMcpPage() {
  const { t } = useTranslation();
  const { data, isLoading } = useProviderMcp();
  const deleteServer = useDeleteProviderMcp();
  const createServer = useCreateProviderMcp();
  const updateServer = useUpdateProviderMcp();

  const [editing, setEditing] = useState<UniversalMcpServer | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  if (isLoading || !data) {
    return <SkeletonList rows={5} />;
  }

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };
  const openEdit = (server: UniversalMcpServer): void => {
    setEditing(server);
    setIsFormOpen(true);
  };

  const readOnly = data.readOnly;

  return (
    <Stack gap="var(--spacing-lg)">
      <PageHeader
        title={t('providerMcp.title', { provider: data.providerName })}
        subtitle={t('providerMcp.subtitle', { provider: data.providerName })}
        helpTopic="mcp"
        actions={
          !readOnly && (
            <Button
              variant="primary"
              leftIcon={<Icon name="plus" size={24} />}
              onClick={openCreate}
            >
              {t('mcp.addServer')}
            </Button>
          )
        }
      />

      <ExplainBox
        title={t('mcp.explainTitle')}
        text={t('providerMcp.explain', { fileName: data.filePath, format: data.format })}
      />

      {!data.cliDetected && (
        <Card padding="sm">
          <Stack direction="row" align="center" gap="var(--spacing-xs)">
            <Icon name="info" size={18} />
            <Typography variant="body-sm" color="muted">
              {t('providerMcp.cliMissing', { provider: data.providerName, path: data.filePath })}
            </Typography>
          </Stack>
        </Card>
      )}

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

      <Stack gap="var(--spacing-sm)">
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
      </Stack>

      {data.servers.length === 0 && <Typography color="subtle">{t('common.empty')}</Typography>}

      <ProviderMcpForm
        isOpen={isFormOpen}
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
