import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderChatMessage } from '@claude-control/contracts';
import { scanSplitBlocks } from '@claude-control/contracts/task-split';
import { scanHandoffBlocks } from '@claude-control/contracts/chat-handoff';
import { TaskSplitCard, HandoffCard } from '@features/ChatMessages';
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
  onSplit,
  onKeepHere,
  isSplitPending,
  onHandoff,
  onHandoffKeepHere,
  isHandoffPending,
}: ProviderChatMessagesProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  // Предложения панели приходят блоками в ответе — теми же самыми, что и у
  // Claude, и разбираются тем же кодом. Отвечать можно только по ПОСЛЕДНЕЙ
  // реплике: предложение из середины истории давно отработано.
  const lastId = messages[messages.length - 1]?.id;

  /** Текст реплики без блоков предложений плюс карточки на их месте. */
  const renderTurn = (message: ProviderChatMessage): ReactNode => {
    const split = scanSplitBlocks(message.content);
    const handoff = scanHandoffBlocks(split.text);
    if (split.proposals.length === 0 && handoff.proposals.length === 0) {
      return <Typography className={styles.turnText}>{message.content}</Typography>;
    }
    const isLast = message.id === lastId;
    return (
      <>
        {handoff.text && <Typography className={styles.turnText}>{handoff.text}</Typography>}
        {split.proposals.map((proposal, index) => (
          <TaskSplitCard
            key={index}
            proposal={proposal}
            onSplit={isLast && onSplit ? (options) => onSplit(proposal, options) : undefined}
            {...(isLast && onKeepHere ? { onKeepHere } : {})}
            isPending={isSplitPending}
            disabled={isRunning}
          />
        ))}
        {handoff.proposals.map((proposal, index) => (
          <HandoffCard
            key={index}
            proposal={proposal}
            onContinue={isLast && onHandoff ? (options) => onHandoff(proposal, options) : undefined}
            {...(isLast && onHandoffKeepHere ? { onKeepHere: onHandoffKeepHere } : {})}
            isPending={isHandoffPending}
            disabled={isRunning}
          />
        ))}
      </>
    );
  };

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
              {renderTurn(message)}
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
