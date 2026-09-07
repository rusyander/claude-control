import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import { mcpServerApi } from '@entities/McpServer';
import { useConnectAtlassianMcp, useTestTelegram, useTestWebhook } from '@entities/Integration';
import type { TelegramEvent } from '@agentdeck/contracts';
import { toggleEvent } from '../model/draft';
import type { IntegrationCardExtrasProps } from './IntegrationCardExtras.types';
import styles from './IntegrationsEditor.module.scss';

/** Имя, под которым панель регистрирует собственный MCP-сервер над Atlassian. */
const MCP_NAME = 'atlassian';

/**
 * То, что есть только у части коннекторов: подписка на события (Telegram и
 * вебхук), отправка пробного сообщения и регистрация собственного MCP-сервера.
 *
 * Вынесено из карточки, чтобы её общая часть оставалась общей: как только
 * особенности расползаются по пяти веткам в одном компоненте, карточки
 * начинают тихо расходиться друг с другом.
 *
 * Список событий у Telegram и вебхука ОДИН и рисуется одним куском: это одни и
 * те же события панели, и два одинаковых списка разошлись бы на первом новом.
 */
export function IntegrationCardExtras({
  id,
  events,
  onEventsChange,
  allEvents,
}: IntegrationCardExtrasProps) {
  const { t } = useTranslation();
  const testTelegram = useTestTelegram();
  const testWebhook = useTestWebhook();
  const connectMcp = useConnectAtlassianMcp();
  const servers = mcpServerApi.useList();

  const eventPicker = (
    <Stack direction="row" gap="var(--spacing-xs)" wrap>
      {allEvents.map((event: TelegramEvent) => (
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
  );

  if (id === 'telegram') {
    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('integrations.telegram.eventsTitle')}
        </Typography>
        {eventPicker}
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

  if (id === 'webhook') {
    return (
      <Stack gap="var(--spacing-2xs)">
        <Typography variant="caption" color="subtle">
          {t('integrations.telegram.eventsTitle')}
        </Typography>
        {eventPicker}
        <Stack direction="row" gap="var(--spacing-xs)">
          {/* Проверка — настоящий POST: «панель настроена» и «приёмник принял»
              разные утверждения, а человеку нужно второе. */}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Icon name="send" size={18} />}
            onClick={() => testWebhook.mutate()}
            isLoading={testWebhook.isPending}
          >
            {t('integrations.webhook.test')}
          </Button>
        </Stack>
        <Typography variant="caption" color="subtle" className="prose">
          {t('integrations.webhook.signature')}
        </Typography>
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
