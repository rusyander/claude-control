import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { SkeletonList, SkeletonText } from '@shared/ui/skeleton';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { CrashCard, ErrorBoundary } from '@shared/ui/error-boundary';
import { toast } from '@shared/lib/toast';
import { isStreamShown } from '@shared/lib/chat-stream';
import { markQuestionAnswered, useAnsweredQuestions } from '@shared/lib/agent-runs';
import { branchMarks } from '../lib/branchMarks';
import { parseQuestions } from '../lib/parseQuestions';
import { liveQuestionKey } from '../lib/questionKey';
import { useMessageTimings } from '../lib/useMessageTimings';
import { useFeedScroll } from '../lib/useFeedScroll';
import { MessageBubble } from './MessageBubble';
import { StreamedAnswer } from './StreamedAnswer';
import { QuestionCard } from './QuestionCard';
import { PermissionCard } from './PermissionCard';
import { BranchGateCard } from './BranchGateCard';
import { ChildBlocks } from './ChildBlocks';
import { ReviewDecisionCard } from './ReviewDecisionCard';
import { waitsDecision } from '../lib/reviewWaiting';
import { taskNoticesOf } from '../lib/taskNotice';
import { FeedNotices } from './FeedNotices';
import { QueuedBubbles } from './QueuedBubbles';
import { RunTimer } from './RunTimer';
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
  modelName,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onEdit,
  onPickOption,
  isRunning,
  permissions,
  onPermissionDecide,
  branchGates,
  onBranchDecide,
  childQuestions,
  onChildAnswer,
  childPermissions,
  onChildPermissionDecide,
  childStages,
  onOpenChild,
  childTree,
  onPauseTree,
  onResumeTree,
  treeBusy,
  onAnswerHold,
  holdBusy,
  onRelease,
  releaseBusy,
  onCheckOverlap,
  overlapBusy,
  reviews,
  onReviewDecide,
  onReviewPush,
  reviewBusy,
  onRetry,
  onContinue,
  onRefresh,
  costUnit,
  effort,
  onSplit,
  onKeepHere,
  isSplitPending,
  splitCeiling,
  childBranches,
  handoff,
  queued,
  onCancelQueued,
  mediaModel,
  mediaTopic,
  mediaRevision,
  runStartedAt,
}: ChatMessagesProps) {
  const { t } = useTranslation();
  const timings = useMessageTimings(messages, isRunning);
  // Отвеченные вопросы детей: пока прогон ребёнка жив, источник отдаёт тот же
  // последний `AskUserQuestion`, и без общей памяти он воскресал на каждый
  // возврат на вкладку — а второй ответ стоит ещё одного хода агента.
  const answered = useAnsweredQuestions();
  const feed = useFeedScroll({
    conversationId,
    messageCount: messages.length,
    streamText: stream.text,
    streamToolCount: stream.tools.length,
    stalled: stream.stalled,
    permissionCount: permissions?.length,
  });

  /** Где по ленте агент сменил ветку — по записям самого транскрипта. */
  const branches = useMemo(() => branchMarks(messages), [messages]);

  /**
   * Сообщение с вопросом, который ещё ЖДЁТ ответа.
   *
   * Отвечать раньше можно было только на последнее сообщение ленты — и это
   * ломалось само по себе, без чужого участия. `AskUserQuestion` в пакетном
   * режиме сразу возвращается ошибкой, поэтому агент задаёт вопрос ПОСРЕДИ хода
   * и продолжает писать: через несколько секунд карточка переставала быть
   * последней и молча становилась нечитаемой картинкой — варианты на экране
   * есть, нажать нельзя. Человек при этом успевал ответить на один вопрос из
   * четырёх и терял остальные.
   *
   * Ищем с конца: реплика человека закрывает вопрос (ответил — не важно, кнопкой
   * или текстом), ответ агента — нет.
   */
  const openQuestionIndex = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) continue;
      // Уведомление CLI о фоне пишется от имени человека, но ответом не является.
      if (message.role === 'user' && !taskNoticesOf(message)) return undefined;
      if (message.blocks.some((block) => block.type === 'tool' && block.name === 'AskUserQuestion'))
        return index;
    }
    return undefined;
  }, [messages]);

  const loadMore = (): void => {
    feed.rememberHeight();
    onLoadMore?.();
  };

  return (
    <div
      className={styles.list}
      ref={feed.listRef}
      onScroll={(event) => feed.onScroll(event.currentTarget)}
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
        <Fragment key={message.id}>
          {/* Смена ветки — событие разговора, а не свойство шапки: показываем
              её ровно там, где она случилась, чтобы дальнейшие правки читались
              как сделанные уже в другой ветке. */}
          {branches.has(message.id) && (
            <div className={styles.branchMark} role="status">
              <Icon name="branch" size={14} />
              <span>{t('chat.branchSwitched', { branch: branches.get(message.id) })}</span>
            </div>
          )}

          {/* Битое сообщение (неожиданный формат транскрипта) прячет только
              себя, а не всю переписку с полем ввода. */}
          <ErrorBoundary
            scope={`сообщение ${message.id}`}
            fallback={(error, reset) => (
              <CrashCard compact error={error} text={t('chat.messageCrash')} onRetry={reset} />
            )}
          >
            <MessageBubble
              message={message}
              onEdit={onEdit}
              onPickOption={onPickOption}
              isLast={index === messages.length - 1}
              isQuestionOpen={index === openQuestionIndex}
              isRunning={isRunning}
              costUnit={costUnit}
              timing={timings.get(message.id)}
              {...(conversationId ? { mediaChatId: conversationId } : {})}
              {...(mediaModel ? { mediaModel } : {})}
              {...(mediaTopic ? { mediaTopic } : {})}
              {...(mediaRevision ? { mediaRevision } : {})}
              onSplit={onSplit}
              onKeepHere={onKeepHere}
              isSplitPending={isSplitPending}
              splitCeiling={splitCeiling}
              childBranches={childBranches}
              handoff={handoff}
            />
          </ErrorBoundary>
        </Fragment>
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
                // Имя живого вопроса — id вызова, без имени разговора: оно у
                // разговора меняется (черновое → sessionId), id — нет.
                const key = liveQuestionKey(conversationId ?? 'stream', tool.id, tool.input);
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
                    <QuestionCard
                      questions={questions}
                      onPick={
                        onPickOption &&
                        ((answer) => {
                          markQuestionAnswered(key);
                          onPickOption(answer);
                        })
                      }
                      busy={isRunning}
                      isAnswered={answered.has(key)}
                    />
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

            {/* Идущий ответ живёт своим компонентом: он один пересчитывается на
                каждое слово, и разборы его блоков не должны трогать всю ленту. */}
            <StreamedAnswer
              stream={stream}
              {...(splitCeiling ? { splitCeiling } : {})}
              {...(costUnit ? { costUnit } : {})}
              {...(effort ? { effort } : {})}
            />

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
                  {t(stream.tools.length > 0 ? 'chat.pendingTools' : 'chat.pending', {
                    model: modelName ?? t('chat.pendingModelFallback'),
                  })}
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

            {/* Живой таймер под ответом; шагам стрима время не ставится — при
                восстановлении события приходят пачкой и дали бы нули. */}
            {stream.isRunning && runStartedAt !== undefined && (
              <RunTimer since={runStartedAt} className={styles.liveTimer} />
            )}
          </div>
        </div>
      )}

      <FeedNotices stream={stream} onRefresh={onRefresh} />

      {/*
        Дописанное, ждущее конца хода, — в ленте, а не только полоской над
        полем ввода. Ответ занятому агенту иначе не оставлял на экране следа
        вовсе: ни реплики, ни пометки, и минутами непонятно, ушёл ли он.
      */}
      <QueuedBubbles items={queued ?? []} onCancel={onCancelQueued} />

      {permissions && permissions.length > 0 && onPermissionDecide && (
        <PermissionCard permissions={permissions} onDecide={onPermissionDecide} />
      )}

      {branchGates && branchGates.length > 0 && onBranchDecide && (
        <BranchGateCard gates={branchGates} onDecide={onBranchDecide} />
      )}

      {/*
        Всё о детях этого разговора — сводка звеньев, их права, их вопросы —
        одним блоком: порядок внутри него важен (сперва «где все», потом «кого
        ждут»), и держать его целиком проще в одном месте.
      */}
      <ChildBlocks
        stages={childStages}
        onOpenChild={onOpenChild}
        tree={childTree}
        onPauseTree={onPauseTree}
        onResumeTree={onResumeTree}
        treeBusy={treeBusy}
        onAnswerHold={onAnswerHold}
        holdBusy={holdBusy}
        onRelease={onRelease}
        releaseBusy={releaseBusy}
        onCheckOverlap={onCheckOverlap}
        overlapBusy={overlapBusy}
        permissions={childPermissions}
        onPermissionDecide={onChildPermissionDecide}
        questions={childQuestions}
        onAnswer={onChildAnswer}
      />

      {/*
        Ревью чужих MR (Т7) — после сводки детей и перед ошибкой: это решение
        человека, а не отчёт, и стоять ему там же, где стоят вопросы и права,
        — внизу ленты, куда человек и смотрит, вернувшись к разговору.
      */}
      {onReviewDecide &&
        (reviews ?? []).map((item) => (
          <ReviewDecisionCard
            key={item.chatId}
            item={item}
            // «Ко всем» считается по СОСЕДЯМ: сколько ещё карточек этого дерева
            // ждут решения. Своя в счёт не идёт — иначе тумблер обещал бы
            // применить решение к самой себе.
            others={
              (reviews ?? []).filter((other) => waitsDecision(other) && other !== item).length
            }
            onDecide={onReviewDecide}
            {...(onReviewPush ? { onPush: onReviewPush } : {})}
            {...(reviewBusy !== undefined ? { busy: reviewBusy } : {})}
          />
        ))}

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
            {/*
              Три действия вместо одного. «Повторить» отправляет задачу заново —
              но часть работы уже сделана, и переделывать её незачем: «Продолжить»
              просит агента доделать с места обрыва. Текст ошибки нужен целиком —
              его несут в тикет или в поиск, а выделять мышью из ленты неудобно.
              Раньше эти две кнопки жили только в шапке, где их не связать с
              карточкой, из-за которой их ищут.
            */}
            <Stack direction="row" gap="var(--spacing-2xs)" wrap>
              {onRetry && (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Icon name="refresh" size={18} />}
                  onClick={onRetry}
                >
                  {t('chat.retry')}
                </Button>
              )}
              {onContinue && (
                <Button size="sm" variant="secondary" onClick={onContinue}>
                  {t('chat.continue')}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<Icon name="copy" size={18} />}
                onClick={() =>
                  void navigator.clipboard.writeText(stream.error ?? '').then(() => {
                    toast.success(t('toasts.copied'));
                  })
                }
              >
                {t('chat.copyError')}
              </Button>
            </Stack>
          </div>
        </div>
      )}

      <div ref={feed.bottomRef} />
    </div>
  );
}
