import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { MessageBubble } from './MessageBubble';
import { QuestionCard, parseQuestions } from './QuestionCard';
import { PermissionCard } from './PermissionCard';
import type { ChatMessagesProps } from './ChatMessages.types';
import styles from './ChatMessages.module.scss';

/**
 * Лента переписки. Ответ, который печатается прямо сейчас, идёт последним
 * блоком и живёт отдельно от истории: он ещё не записан в транскрипт, а
 * показывать его нужно немедленно.
 */
export function ChatMessages({
  messages,
  stream,
  isLoading,
  onEdit,
  onPickOption,
  isRunning,
  permissions,
  onPermissionDecide,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Держаться ли низа. Пока пользователь внизу — лента едет за ответом; стоит
  // ему отлистать вверх, чтобы перечитать, — отпускаем. Раньше лента тянула
  // вниз на каждом слове, и читать прошлые сообщения во время ответа было
  // нельзя.
  const isPinned = useRef(true);

  // Смена разговора — снова к последнему сообщению.
  const conversationId = messages[0]?.id;
  useEffect(() => {
    isPinned.current = true;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId]);

  useEffect(() => {
    if (isPinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, stream.text, stream.tools.length, permissions?.length]);

  return (
    <div
      className={styles.list}
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget;
        isPinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
      }}
    >
      {isLoading && <SkeletonList rows={3} withActions={false} />}

      {messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          onEdit={onEdit}
          onPickOption={onPickOption}
          isRunning={isRunning}
        />
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

            {stream.tools.map((tool, index) => {
              const questions =
                tool.name === 'AskUserQuestion' ? parseQuestions(tool.input) : undefined;

              if (questions) {
                return (
                  <QuestionCard
                    key={`${tool.name}-${index}`}
                    questions={questions}
                    onPick={onPickOption}
                    disabled={isRunning}
                  />
                );
              }

              return (
                <details key={`${tool.name}-${index}`} className={styles.tool}>
                  <summary>{tool.name}</summary>
                  <div className={styles.toolInput}>{tool.input}</div>
                </details>
              );
            })}

            {stream.text && (
              <div
                className={styles.text}
                // Разметку строит markdown-it с выключенным сырым html.
                dangerouslySetInnerHTML={{ __html: renderMarkdown(stream.text) }}
              />
            )}

            {/*
              Пока ответа ещё нет, показываем, что работа идёт. Одной мигающей
              каретки на пустом месте мало: со стороны это неотличимо от
              зависшего разговора, а до первого слова проходят секунды —
              модель успевает подумать и сходить в инструменты.
            */}
            {stream.isRunning && !stream.text && (
              <div className={styles.pending}>
                <span className={styles.dots} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.pendingLabel}>
                  {stream.tools.length > 0 ? t('chat.pendingTools') : t('chat.pending')}
                </span>
              </div>
            )}

            {stream.isRunning && stream.text && <span className={styles.caret} />}
          </div>
        </div>
      )}

      {permissions && permissions.length > 0 && onPermissionDecide && (
        <PermissionCard permissions={permissions} onDecide={onPermissionDecide} />
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
