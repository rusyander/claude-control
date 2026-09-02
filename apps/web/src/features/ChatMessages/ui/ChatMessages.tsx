import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { scanSplitBlocks } from '@claude-control/contracts/task-split';
import { scanHandoffBlocks } from '@claude-control/contracts/chat-handoff';
import { Stack } from '@shared/ui/stack';
import { SkeletonList, SkeletonText } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { isStreamShown } from '@shared/lib/chat-stream';
import { parseQuestions } from '../lib/parseQuestions';
import { MessageBubble } from './MessageBubble';
import { QuestionCard } from './QuestionCard';
import { TaskSplitCard } from './TaskSplitCard';
import { HandoffCard } from './HandoffCard';
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
  childQuestions,
  onChildAnswer,
  onRetry,
  costUnit,
  effort,
  onSplit,
  onKeepHere,
  isSplitPending,
  handoff,
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

  // Разбор идущего ответа: каждый кусок текста заново, поэтому по памяти — это
  // единственное место ленты, которое пересчитывается на каждое слово. Оба
  // разбора идут цепочкой по одному и тому же тексту — языки блоков разные, и
  // каждый скан видит только свой.
  const streamed = useMemo(() => scanSplitBlocks(stream.text), [stream.text]);
  const streamedHandoff = useMemo(() => scanHandoffBlocks(streamed.text), [streamed.text]);

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

      {messages.map((message, index) => (
        <MessageBubble
          key={message.id}
          message={message}
          onEdit={onEdit}
          onPickOption={onPickOption}
          isLast={index === messages.length - 1}
          isRunning={isRunning}
          costUnit={costUnit}
          onSplit={onSplit}
          onKeepHere={onKeepHere}
          isSplitPending={isSplitPending}
          handoff={handoff}
        />
      ))}

      {isStreamShown(stream) && (
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

              // Расход шага приходит отдельным событием и садится на свой вызов
              // по id. У параллельных вызовов он общий — сколько их было,
              // считаем прямо здесь, по совпадению шага.
              const spend = tool.usage ? (
                <TokenBadge
                  usage={tool.usage}
                  unit={costUnit}
                  effort={effort}
                  label={tool.name}
                  sharedWith={stream.tools.filter((other) => other.usage === tool.usage).length}
                  className={styles.spend}
                />
              ) : null;

              if (questions) {
                return (
                  <div key={`${tool.name}-${index}`} className={styles.block}>
                    {/*
                      Отвечать можно СРАЗУ, не дожидаясь конца хода. Вызов уже
                      вернулся ошибкой (в пакетном режиме `AskUserQuestion`
                      иначе не умеет), агент про вопрос больше не помнит и
                      продолжает работу — а человеку выбор нужен именно сейчас.
                      Ответ занятому агенту уходит в очередь и доедет, как
                      только он закончит ход.
                    */}
                    <QuestionCard questions={questions} onPick={onPickOption} busy={isRunning} />
                    {spend}
                  </div>
                );
              }

              return (
                <div key={`${tool.name}-${index}`} className={styles.block}>
                  <details className={styles.tool}>
                    <summary>{tool.name}</summary>
                    <div className={styles.toolInput}>{tool.input}</div>
                  </details>
                  {spend}
                </div>
              );
            })}

            {stream.text && (
              <div className={styles.block}>
                {/*
                  Предложение разделить задачи прячем из текста уже здесь, пока
                  ответ печатается: иначе в ленте несколько секунд стоял бы голый
                  JSON, а незакрытый блок показывался бы обрубком. Карточку
                  рисуем сразу, но погашенной — решать можно, когда агент
                  договорит, и это ровно то, что видно.
                */}
                <div className={styles.blockBody}>
                  {streamedHandoff.text && (
                    <div
                      className={styles.text}
                      // Разметку строит markdown-it с выключенным сырым html.
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(streamedHandoff.text) }}
                    />
                  )}
                  {streamed.proposals.map((proposal, index) => (
                    <TaskSplitCard key={index} proposal={proposal} disabled />
                  ))}
                  {streamed.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.split.notParsed')}
                    </div>
                  )}
                  {streamedHandoff.proposals.map((proposal, index) => (
                    <HandoffCard key={index} proposal={proposal} disabled />
                  ))}
                  {streamedHandoff.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.handoff.notParsed')}
                    </div>
                  )}
                </div>
                {stream.textUsage && (
                  <TokenBadge
                    usage={stream.textUsage}
                    unit={costUnit}
                    effort={effort}
                    label={t('chat.usage.answer')}
                    className={styles.spend}
                  />
                )}
              </div>
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

            {/*
              Скелетон под подписью: три точки говорят «жив», но не показывают,
              что ответ вообще-то пишется. Полосы занимают место будущего текста,
              поэтому лента не прыгает, когда первые слова наконец приходят.
            */}
            {stream.isRunning && !stream.text && (
              <SkeletonText lines={3} className={styles.pendingSkeleton} />
            )}

            {stream.isRunning && stream.text && <span className={styles.caret} />}
          </div>
        </div>
      )}

      {permissions && permissions.length > 0 && onPermissionDecide && (
        <PermissionCard permissions={permissions} onDecide={onPermissionDecide} />
      )}

      {/*
        Вопросы дочерних разговоров. Ответ уходит в ИХ чат — этот разговор о нём
        не узнает и хода себе не добавит. Подпись обязательна: одинаковых
        вопросов от шести агентов бывает шесть, и без имени чата человек отвечает
        вслепую.
      */}
      {onChildAnswer &&
        (childQuestions ?? []).map((child) => {
          const questions = parseQuestions(child.input);
          if (!questions) return null;
          return (
            <div key={`${child.chatId}-${child.toolUseId ?? 'ask'}`} className={styles.childAsk}>
              <Typography variant="caption" color="subtle" className={styles.childAskFrom}>
                {t('chat.questionFromChild', { title: child.title })}
              </Typography>
              <QuestionCard
                questions={questions}
                onPick={(answer) => onChildAnswer(child.chatId, answer)}
                busy={child.isRunning}
              />
            </div>
          );
        })}

      {/*
        Ошибка — такое же событие разговора, как ответ, и место ей в ленте.
        Раньше здесь была голая красная строка внизу: на длинной переписке её
        не отличить от обрыва, а что делать дальше — не сказано. Карточка
        называет беду, показывает текст целиком (он бывает многострочным) и
        даёт то самое действие, которого человек ищет, — повторить.
      */}
      {stream.error && (
        <div className={styles.row}>
          <div className={styles.errorCard} role="alert" data-chat-error>
            <Stack direction="row" align="center" gap="var(--spacing-2xs)">
              <Icon name="error" size={20} />
              <Typography variant="body-sm" weight="medium" as="span">
                {t('chat.errorTitle')}
              </Typography>
            </Stack>
            <div className={styles.errorText}>{stream.error}</div>
            {onRetry && (
              <Stack direction="row" gap="var(--spacing-2xs)">
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="refresh" size={18} />}
                  onClick={onRetry}
                >
                  {t('chat.retry')}
                </Button>
              </Stack>
            )}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
