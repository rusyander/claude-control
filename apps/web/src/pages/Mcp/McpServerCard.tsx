import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Card } from '@shared/ui/card';
import { Badge } from '@shared/ui/badge';
import { Toggle } from '@shared/ui/toggle';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { DeleteButton } from '@features/EntityDelete';
import { SandboxButton } from '@features/SandboxRunner';
import { McpToolsModal } from '@features/McpToolPicker';
import { useStartOAuth, useClearOAuth } from '@entities/McpServer';
import type { HealthResult, McpServerCardProps } from './McpServerCard.types';

/**
 * Карточка MCP-сервера. Проверка связи по умолчанию запускается по кнопке, а не
 * при открытии страницы: поднять сервер стоит времени, а серверов может быть
 * много. Автопроверку при открытии включает настройка mcpAutoCheck (prop
 * `autoCheck`).
 */
export function McpServerCard({
  server,
  onToggle,
  onEdit,
  onDelete,
  isDeleting,
  autoCheck,
}: McpServerCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isToolsOpen, setIsToolsOpen] = useState(false);
  const autoChecked = useRef(false);

  const startOAuth = useStartOAuth();
  const clearOAuth = useClearOAuth();

  const checkHealth = async (): Promise<void> => {
    setIsChecking(true);
    try {
      const { data } = await apiClient.post<HealthResult>(`/mcp/${server.id}/health`);
      setHealth(data);
    } finally {
      setIsChecking(false);
    }
  };

  // Автопроверка при открытии раздела (настройка mcpAutoCheck): один раз на
  // карточку и только для включённых серверов — выключенные проверять нечего.
  useEffect(() => {
    if (!autoCheck || !server.isEnabled || autoChecked.current) return;
    autoChecked.current = true;
    void checkHealth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck, server.isEnabled]);

  // OAuth есть только у сетевых серверов; у stdio авторизоваться негде.
  const canOAuth = server.transport !== 'stdio';

  const authorize = (): void => {
    // Окно открываем синхронно по клику: если ждать ответа сервера, а потом
    // открывать, блокировщик всплывающих окон успеет его срезать.
    const popup = window.open('about:blank', 'mcp-oauth', 'width=600,height=760');

    startOAuth.mutate(server.id, {
      onSuccess: (result) => {
        if (result.status === 'authorized') {
          popup?.close();
          void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
          return;
        }
        if (result.authorizationUrl && popup) {
          popup.location.href = result.authorizationUrl;
          // Окно закрылось — вход, скорее всего, завершён: обновляем статус.
          const timer = window.setInterval(() => {
            if (popup.closed) {
              window.clearInterval(timer);
              void queryClient.invalidateQueries({ queryKey: queryKeys.mcp });
            }
          }, 1000);
        }
      },
      onError: () => popup?.close(),
    });
  };

  const status = health?.health ?? server.health;

  return (
    <>
      <Card padding="md">
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
              {canOAuth && server.hasOAuth && <Badge tone="success">{t('mcp.authorized')}</Badge>}
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

          <Stack direction="row" align="center" gap="var(--spacing-xs)" wrap justify="end">
            {canOAuth &&
              (server.hasOAuth ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => clearOAuth.mutate(server.id)}
                  isLoading={clearOAuth.isPending}
                >
                  {t('mcp.signOut')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={authorize}
                  isLoading={startOAuth.isPending}
                >
                  {t('mcp.authorize')}
                </Button>
              ))}
            <Button size="sm" onClick={checkHealth} isLoading={isChecking}>
              {t('mcp.checkHealth')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setIsToolsOpen(true)}>
              {t('mcp.toolsButton')}
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
            <Toggle
              checked={server.isEnabled}
              onCheckedChange={onToggle}
              aria-label={server.name}
            />
          </Stack>
        </Stack>
      </Card>

      <McpToolsModal isOpen={isToolsOpen} onOpenChange={setIsToolsOpen} server={server} />
    </>
  );
}
