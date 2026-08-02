import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ProviderChatMessagesProps } from './ProviderChatMessages.types';
import styles from './ProviderChatPage.module.scss';

/**
 * Лента переписки. Идущий ответ показывается отдельной репликой, которая растёт
 * по мере печати, — это ровно то, что процесс вывел, без разбора чужого формата.
 */
export function ProviderChatMessages({
  messages,
  providerName,
  partial,
  isRunning,
  isEmptyState,
  onCreate,
  isCreating,
}: ProviderChatMessagesProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Лента едет вниз на каждый кусок ответа: иначе растущий текст уезжал бы за
  // край, и человек читал бы середину, а не конец.
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, partial]);

  const isBlank = messages.length === 0 && !partial;

  return (
    <div className={styles.list} ref={listRef}>
      {isBlank ? (
        // Ключи у веток разные намеренно: без них React переиспользует тот же
        // div и меняет на нём `flex` на месте, а смена сокращённого свойства на
        // развёрнутое — предупреждение в консоли и потенциальный сбой стиля.
        <Stack
          key="empty"
          align="center"
          justify="center"
          flex={1}
          gap="var(--spacing-sm)"
          className={styles.empty}
        >
          <Icon name="chat" size={40} />
          <Typography variant="heading-sm">
            {t('providerChat.title', { provider: providerName })}
          </Typography>
          <Typography color="muted" className={styles.emptyText}>
            {isEmptyState ? t('providerChat.startHint') : t('providerChat.empty')}
          </Typography>
          {isEmptyState && (
            <Button
              variant="primary"
              onClick={onCreate}
              isLoading={isCreating}
              leftIcon={<Icon name="plus" size={18} />}
            >
              {t('providerChat.new')}
            </Button>
          )}
        </Stack>
      ) : (
        <Stack key="list" gap="var(--spacing-sm)" padding="var(--spacing-md) var(--spacing-xl)">
          {messages.map((message) => (
            <Stack
              key={message.id}
              gap="var(--spacing-3xs)"
              className={[
                message.role === 'user' ? styles.userTurn : styles.assistantTurn,
                message.failed ? styles.failedTurn : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <Typography variant="caption" color="subtle" as="span">
                {message.role === 'user' ? t('providerChat.you') : providerName}
                {message.failed ? ` · ${t('providerChat.failed')}` : ''}
              </Typography>
              <Typography className={styles.turnText}>{message.content}</Typography>
            </Stack>
          ))}

          {isRunning && (
            <Stack gap="var(--spacing-3xs)" className={styles.assistantTurn}>
              <Typography variant="caption" color="subtle" as="span">
                {providerName}
              </Typography>
              <Typography className={styles.turnText}>
                {partial || t('providerChat.thinking')}
                <span className={styles.caret}>▍</span>
              </Typography>
            </Stack>
          )}
        </Stack>
      )}
    </div>
  );
}
