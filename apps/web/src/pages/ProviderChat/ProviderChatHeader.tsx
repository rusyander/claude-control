import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Badge } from '@shared/ui/badge';
import { Icon } from '@shared/ui/icon';
import type { ProviderChatHeaderProps } from './ProviderChatHeader.types';
import styles from './ProviderChatPage.module.scss';

/**
 * Шапка разговора: как он называется, чем отвечает провайдер и где работает CLI.
 *
 * Способ ответа (`stream` / `session` / `api`) показывается меткой не ради
 * украшения: у одного и того же провайдера он зависит от того, установлен ли
 * CLI и есть ли ключ, — и без метки непонятно, почему ответ приходит сразу
 * целиком, а не по словам.
 */
export function ProviderChatHeader({
  chat,
  providerName,
  runner,
  isRunning,
  onRename,
  onPickWorkdir,
  onDelete,
  onStop,
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
        {runner && runner.mode !== 'none' && (
          <Badge tone="neutral">{t(`providerChat.mode.${runner.mode}`)}</Badge>
        )}
        {transport && <Badge tone="neutral">{t(`providerChat.transport.${transport}`)}</Badge>}
        {chat?.workdir && (
          <Badge tone="neutral">{t('providerChat.workdirBadge', { path: chat.workdir })}</Badge>
        )}
      </Stack>

      <Stack direction="row" align="center" gap="var(--spacing-3xs)" wrap>
        {isRunning && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onStop}
            leftIcon={<Icon name="stop" size={16} />}
          >
            {t('providerChat.stop')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onPickWorkdir} disabled={!chat}>
          {t('providerChat.workdir')}
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
