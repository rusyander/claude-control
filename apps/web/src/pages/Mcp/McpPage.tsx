import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpServer } from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { useEntityUrl, useEntityUrlWriter } from '@shared/hooks/use-entity-url';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { PageHeader } from '@shared/ui/page-header';
import { ExplainBox } from '@shared/ui/explain-box';
import { McpFormModal } from '@features/McpEditor';
import { mcpServerApi } from '@entities/McpServer';
import { McpServerCard } from './McpServerCard';
import styles from './McpPage.module.scss';

/** Раздел MCP-серверов: состав, состояние и проверка связи. */
export function McpPage() {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<McpServer | undefined>(undefined);
  const [isFormOpen, setIsFormOpen] = useState(false);

  const { data: servers = [], isLoading } = mcpServerApi.useList();
  const setEnabled = mcpServerApi.useSetEnabled();
  const deleteServer = mcpServerApi.useDelete();

  const openCreate = (): void => {
    setEditing(undefined);
    setIsFormOpen(true);
  };

  const openEdit = (server: McpServer): void => {
    setEditing(server);
    setIsFormOpen(true);
    writeUrl(server.id);
  };

  // Ссылка /mcp?id=<имя сервера> открывает его настройки.
  const writeUrl = useEntityUrlWriter();
  useEntityUrl<McpServer>({ items: servers, getId: (server) => server.id, onOpen: openEdit });

  const closeForm = (open: boolean): void => {
    setIsFormOpen(open);
    if (!open) writeUrl(undefined);
  };

  return (
    <Stack gap="var(--spacing-lg)" className={styles.page}>
      <PageHeader
        title={t('mcp.title')}
        subtitle={t('mcp.subtitle')}
        helpTopic="mcp"
        actions={
          <Button variant="primary" leftIcon={<Icon name="plus" size={24} />} onClick={openCreate}>
            {t('mcp.addServer')}
          </Button>
        }
      />

      <ExplainBox title={t('mcp.explainTitle')} text={t('mcp.explain')} />

      {isLoading && <SkeletonList rows={5} />}

      <Stack gap="var(--spacing-sm)">
        {servers.map((server) => (
          <McpServerCard
            key={server.id}
            server={server}
            onToggle={(isEnabled) => setEnabled.mutate({ id: server.id, isEnabled })}
            onEdit={() => openEdit(server)}
            onDelete={() => deleteServer.mutate(server.id)}
            isDeleting={deleteServer.isPending}
          />
        ))}
      </Stack>

      {!isLoading && servers.length === 0 && (
        <Typography color="subtle">{t('common.empty')}</Typography>
      )}

      <McpFormModal isOpen={isFormOpen} onOpenChange={closeForm} server={editing} />
    </Stack>
  );
}
