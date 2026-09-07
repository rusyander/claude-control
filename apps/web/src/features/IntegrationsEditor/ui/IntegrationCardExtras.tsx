import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { mcpServerApi } from '@entities/McpServer';
import { useConnectAtlassianMcp, useTestTelegram } from '@entities/Integration';
import { toggleEvent } from '../model/draft';
import type { IntegrationCardExtrasProps } from './IntegrationCardExtras.types';
import styles from './IntegrationsEditor.module.scss';

/** Имя, под которым панель регистрирует собственный MCP-сервер над Atlassian. */
const MCP_NAME = 'atlassian';

/**
 * То, что есть только у одного коннектора: события Telegram, отправка пробного
 * сообщения и регистрация собственного MCP-сервера панели.
 *
 * Вынесено из карточки, чтобы её общая часть оставалась общей: как только
 * особенности расползаются по пяти веткам в одном компоненте, карточки
 * начинают тихо расходиться друг с другом.
 */
export function IntegrationCardExtras({
  id,
  events,
  onEventsChange,
  allEvents,
}: IntegrationCardExtrasProps) {
  const { t } = useTranslation();
  const testTelegram = useTestTelegram();
  const connectMcp = useConnectAtlassianMcp();
  const servers = mcpServerApi.useList();

  if (id === 'telegram') {
    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('integrations.telegram.eventsTitle')}
        </Typography>
        <Stack direction="row" gap="var(--spacing-xs)" wrap>
          {allEvents.map((event) => (
            <label key={event} className={styles.eventRow}>
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={() => onEventsChange(toggleEvent(events, allEvents, event))}
              />
              <Typography variant="body-sm" as="span">
                {t(`integrations.telegram.event.${event}`)}
              </Typography>
            </label>
          ))}
        </Stack>
        <Stack direction="row" gap="var(--spacing-xs)">
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="send" size={18} />}
            onClick={() => testTelegram.mutate()}
            isLoading={testTelegram.isPending}
          >
            {t('integrations.telegram.test')}
          </Button>
        </Stack>
      </Stack>
    );
  }

  if (id !== 'atlassian') return null;

  // Сервер уже зарегистрирован — кнопка отключает. Список MCP панель и так
  // держит в кэше, отдельного «а подключено ли» с сервера не нужно.
  const isConnected = (servers.data ?? []).some((server) => server.id === MCP_NAME);

  return (
    <Stack gap="var(--spacing-2xs)">
      <Stack direction="row" gap="var(--spacing-xs)" align="center" wrap>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<Icon name="mcp" size={18} />}
          onClick={() => connectMcp.mutate(isConnected)}
          isLoading={connectMcp.isPending}
        >
          {isConnected ? t('integrations.mcp.disconnect') : t('integrations.mcp.connect')}
        </Button>
      </Stack>
      <Typography variant="caption" color="subtle" className="prose">
        {t('integrations.mcp.hint')}
      </Typography>
    </Stack>
  );
}
