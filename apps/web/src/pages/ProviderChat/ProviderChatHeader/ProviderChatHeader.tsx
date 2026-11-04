import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { ProviderChatHeaderProps } from './ProviderChatHeader.types';
import styles from './ProviderChatHeader.module.scss';

/**
 * Шапка старого разговора чужого CLI (этап 10, F2c): название, чем он шёл, где работал CLI и
 * действия над историей. Ход, остановка, перезапуск, тумблер правок и смена каталога ушли
 * вместе с прежним исполнителем — чат идёт в ядре, туда ведёт «Продолжить в чате ядра».
 */
export function ProviderChatHeader({
  chat,
  providerName,
  onRename,
  onDelete,
  onContinue,
}: ProviderChatHeaderProps) {
  const { t } = useTranslation();
  const transport = chat?.messages.findLast((message) => message.transport)?.transport;

  const rename = (): void => {
    const next = window.prompt(t('providerChat.renamePrompt'), chat?.title ?? '');
    if (next?.trim()) onRename(next.trim());
  };

  return (
    <Stack
      direction="row"
      align="center"
      justify="between"
      gap="var(--spacing-sm)"
      wrap
      padding="var(--spacing-xs) var(--spacing-xl)"
      className={styles.header}
    >
      <Stack direction="row" align="center" gap="var(--spacing-2xs)" wrap>
        <Typography variant="body" weight="medium">
          {chat?.title ?? t('providerChat.title', { provider: providerName })}
        </Typography>
        {chat && <Badge tone="neutral">{t('providerChat.history.badge')}</Badge>}
        {transport && <Badge tone="neutral">{t(`providerChat.transport.${transport}`)}</Badge>}
        {chat?.model && (
          <Badge tone="neutral">{t('providerChat.modelBadge', { model: chat.model })}</Badge>
        )}
        {chat?.workdir && (
          <Badge tone="neutral">{t('providerChat.workdirBadge', { path: chat.workdir })}</Badge>
        )}
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        <Button
          size="sm"
          variant="primary"
          onClick={onContinue}
          leftIcon={<Icon name="chat" size={16} />}
          data-provider-chat-continue-core
        >
          {t('providerChat.history.continue')}
        </Button>
        <Button size="sm" variant="ghost" onClick={rename} disabled={!chat}>
          {t('providerChat.rename')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={!chat}>
          {t('providerChat.delete')}
        </Button>
      </Stack>
    </Stack>
  );
}
