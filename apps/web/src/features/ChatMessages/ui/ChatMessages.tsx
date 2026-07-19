import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { MessageBubble } from './MessageBubble';
import type { ChatMessagesProps } from './ChatMessages.types';
import styles from './ChatMessages.module.scss';

/**
 * Лента переписки. Ответ, который печатается прямо сейчас, идёт последним
 * блоком и живёт отдельно от истории: он ещё не записан в транскрипт, а
 * показывать его нужно немедленно.
 */
export function ChatMessages({ messages, stream, isLoading, onEdit }: ChatMessagesProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Держим ленту у нижнего края, пока текст набирается.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, stream.text, stream.tools.length]);

  return (
    <div className={styles.list}>
      {isLoading && <SkeletonList rows={3} withActions={false} />}

      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onEdit={onEdit} />
      ))}

      {(stream.isRunning || stream.text) && (
        <div className={styles.row}>
          <div className={`${styles.bubble} ${styles.bubbleAssistant}`}>
            {stream.thinking && (
              <details className={styles.thinking}>
                <summary>{t('chat.thinking')}</summary>
                <div className={styles.thinkingBody}>{stream.thinking}</div>
              </details>
            )}

            {stream.tools.map((tool, index) => (
              <details key={`${tool.name}-${index}`} className={styles.tool}>
                <summary>{tool.name}</summary>
                <div className={styles.toolInput}>{tool.input}</div>
              </details>
            ))}

            <div
              className={styles.text}
              // Разметку строит markdown-it с выключенным сырым html.
              dangerouslySetInnerHTML={{ __html: renderMarkdown(stream.text) }}
            />

            {stream.isRunning && <span className={styles.caret} />}
          </div>
        </div>
      )}

      {stream.error && (
        <Stack gap="var(--spacing-2xs)">
          <Typography variant="body-sm" color="danger">
            {stream.error}
          </Typography>
        </Stack>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
