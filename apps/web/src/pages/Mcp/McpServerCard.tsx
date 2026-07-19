import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import type { HealthResult, McpServerCardProps } from './McpServerCard.types';

/**
 * Карточка MCP-сервера. Проверка связи запускается по кнопке, а не при
 * открытии страницы: поднять сервер стоит времени, а серверов может быть много.
 */
export function McpServerCard({
  server,
  onToggle,
  onEdit,
  onDelete,
  isDeleting,
}: McpServerCardProps) {
  const { t } = useTranslation();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const checkHealth = async (): Promise<void> => {
    setIsChecking(true);
    try {
      const { data } = await apiClient.post<HealthResult>(`/mcp/${server.id}/health`);
      setHealth(data);
    } finally {
      setIsChecking(false);
    }
  };

  const status = health?.health ?? server.health;

  return (
    <Card padding="md">
      <Stack direction="row" gap="var(--spacing-md)" align="start" width="100%">
        <Stack gap="var(--spacing-2xs)" flex={1} minWidth={0}>
          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap>
            <Typography variant="body" weight="medium" as="span">
              {server.name}
            </Typography>
            <Badge tone="neutral">{server.transport}</Badge>
            {status === 'connected' && (
              <Badge tone="success" withDot>
                {t('mcp.connected')}
                {health?.toolCount !== undefined && `: ${health.toolCount} ${t('mcp.tools')}`}
              </Badge>
            )}
            {status === 'failed' && (
              <Badge tone="danger" withDot>
                {t('mcp.failed')}
              </Badge>
            )}
            {!server.isEnabled && <Badge tone="neutral">{t('common.disabled')}</Badge>}
          </Stack>

          <Typography variant="mono" color="subtle" as="span" truncate>
            {server.command
              ? `${server.command} ${server.args.join(' ')}`.trim()
              : (server.url ?? '')}
          </Typography>

          {health?.detail && (
            <Typography variant="caption" color="danger">
              {health.detail}
            </Typography>
          )}
        </Stack>

        <Stack direction="row" align="center" gap="var(--spacing-xs)" flexShrink={0}>
          <Button size="sm" onClick={checkHealth} isLoading={isChecking}>
            {t('mcp.checkHealth')}
          </Button>
          <SandboxButton
            kind="mcp"
            title={server.name}
            mcpId={server.id}
            selection={{ mcpIds: [server.id] }}
          />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Icon name="edit" size={24} />}
            aria-label={`${t('common.edit')}: ${server.name}`}
            onClick={onEdit}
          />
          <DeleteButton
            entityName={server.name}
            description={t('common.deleteMcp')}
            onDelete={onDelete}
            isPending={isDeleting}
          />
          <Toggle checked={server.isEnabled} onCheckedChange={onToggle} aria-label={server.name} />
        </Stack>
      </Stack>
    </Card>
  );
}
