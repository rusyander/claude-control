import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
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
  conversationId,
  stream,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
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

  // Высота ленты в момент клика «Загрузить ещё»: подгруженные сверху сообщения
  // сдвигают содержимое вниз, и без поправки прокрутки лента прыгала бы. После
  // прибавки восстанавливаем позицию по приросту высоты.
  const restoreScroll = useRef<number | undefined>(undefined);

  // Смена разговора — снова к последнему сообщению. Ключ — id разговора, а не
  // первого сообщения: при подгрузке более ранних первое сообщение меняется, но
  // прокрутку к низу это запускать не должно.
  useEffect(() => {
    isPinned.current = true;
    restoreScroll.current = undefined;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [conversationId]);

  useEffect(() => {
    // Подгрузка более ранних не должна утягивать ленту вниз — её обрабатывает
    // отдельный layout-эффект восстановления позиции.
    if (restoreScroll.current !== undefined) return;
    if (isPinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, stream.text, stream.tools.length, permissions?.length]);

  // Восстановление позиции после подгрузки более ранних: держим на экране то же
  // сообщение, что и было, компенсируя прокрутку приростом высоты сверху.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || restoreScroll.current === undefined) return;
    list.scrollTop += list.scrollHeight - restoreScroll.current;
    restoreScroll.current = undefined;
  }, [messages.length]);

  const loadMore = (): void => {
    if (listRef.current) restoreScroll.current = listRef.current.scrollHeight;
    onLoadMore?.();
  };

  return (
    <div
      className={styles.list}
      ref={listRef}
      onScroll={(event) => {
        const list = event.currentTarget;
        isPinned.current = list.scrollHeight - list.scrollTop - list.clientHeight < 160;
      }}
    >
      {hasMore && onLoadMore && (
        <Stack align="center" padding="var(--spacing-2xs) 0">
          <Button
            size="sm"
            variant="ghost"
            onClick={loadMore}
            isLoading={isLoadingMore}
            disabled={isLoadingMore}
          >
            {t('chat.loadOlder')}
          </Button>
        </Stack>
      )}

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
              <Stack
                direction="row"
                align="center"
                gap="var(--spacing-xs)"
                className={styles.pending}
              >
                <span className={styles.dots} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <Typography
                  as="span"
                  variant="body-sm"
                  color="muted"
                  className={styles.pendingLabel}
                >
                  {stream.tools.length > 0 ? t('chat.pendingTools') : t('chat.pending')}
                </Typography>
              </Stack>
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
