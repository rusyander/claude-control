import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderChatMessage } from '@agentdeck/contracts';
import { scanSplitBlocks } from '@agentdeck/contracts/task-split';
import { scanHandoffBlocks } from '@agentdeck/contracts/chat-handoff';
import { scanReviewBlocks } from '@agentdeck/contracts/model-cascade';
import { scanMediaBlocks } from '@agentdeck/contracts/media-block';
import {
  TaskSplitCard,
  HandoffCard,
  ChildStages,
  MediaFeedCard,
  ReviewDecisionCard,
  waitsDecision,
} from '@features/ChatMessages';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { formatDuration } from '@shared/lib/format-duration';
import { ContextSummarizedNote } from '@entities/Platform';
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
  stages,
  tree,
  onOpenChild,
  onPauseAll,
  onResumeAll,
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
  onReviewRetry,
  reviewBusy,
  mediaChatId,
  mediaModel,
  mediaTopic,
  mediaRevision,
}: ProviderChatMessagesProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * Время ответа и сумма по разговору. У Claude это живёт в бейдже расхода, но
   * бейджу нужен расход, а чужой CLI его не отдаёт — здесь остаётся то, что есть
   * всегда: часы панели. Сумма копится по порядку реплик, поэтому считается
   * один раз на всю ленту, а не в каждой строке.
   */
  const timings = new Map<string, { step: number; total: number }>();
  let running = 0;
  for (const message of messages) {
    if (message.durationMs === undefined) continue;
    running += message.durationMs;
    timings.set(message.id, { step: message.durationMs, total: running });
  }

  // Предложения панели приходят блоками в ответе — теми же самыми, что и у
  // Claude, и разбираются тем же кодом. Отвечать можно только по ПОСЛЕДНЕЙ
  // реплике: предложение из середины истории давно отработано.
  const lastId = messages[messages.length - 1]?.id;

  /**
   * Время под ответом: шаг и, со второго ответа, сумма по разговору. Формат и
   * знак суммы — те же, что в бейдже расхода у Claude; реплика без времени
   * (запись, сделанная до этой правки) строки не получает вовсе — выдуманный
   * ноль хуже пустого места.
   */
  const renderTime = (message: ProviderChatMessage): ReactNode => {
    const time = timings.get(message.id);
    if (!time) return null;
    const step = formatDuration(time.step, t);
    const total = formatDuration(time.total, t);
    const withTotal = time.total !== time.step;
    return (
      <Typography variant="caption" color="subtle" as="span" className={styles.turnTime}>
        {/* Числа читаются глазами, а вслух — целой фразой: `Σ` голосом не
            произносится, а подписать span атрибутом нельзя, у него нет роли. */}
        <span className={styles.turnTimeLabel}>
          {withTotal
            ? t('providerChat.timing.full', { step, total })
            : t('providerChat.timing.step', { step })}
        </span>
        <span aria-hidden="true">{step}</span>
        {withTotal && <span aria-hidden="true">{`Σ ${total}`}</span>}
      </Typography>
    );
  };

  /** Текст реплики без блоков предложений плюс карточки на их месте. */
  const renderTurn = (message: ProviderChatMessage): ReactNode => {
    const split = scanSplitBlocks(message.content);
    const handoff = scanHandoffBlocks(split.text);
    // Блок вердикта ревью — служебный: по нему панель заводит звено правок, а
    // человеку нужен разбор словами. У Claude его убирает `MessageBubble`; здесь
    // своя лента, и без этой строки звенья конвейера у чужого CLI показывали бы
    // сырой JSON (проверено на живом прогоне 08.09.2026).
    const review = scanReviewBlocks(handoff.text);
    // Вложения агента (Т10): рисунок и колода приезжают блоками, и карточка
    // встаёт на их место. Именно эта дорога и работает у чужого CLI — ни
    // контура, ни ключа она не требует.
    const media = scanMediaBlocks(review.text);
    const hasCards =
      split.proposals.length > 0 ||
      handoff.proposals.length > 0 ||
      media.decks.length > 0 ||
      media.pictures.length > 0 ||
      media.rejected > 0;
    if (!hasCards) {
      return <Typography className={styles.turnText}>{media.text}</Typography>;
    }
    const isLast = message.id === lastId;
    return (
      <>
        {media.text && <Typography className={styles.turnText}>{media.text}</Typography>}
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
        {media.pictures.map((svg, index) => (
          <MediaFeedCard
            key={`svg-${index}`}
            svg={svg}
            {...(mediaChatId ? { chatId: mediaChatId } : {})}
            {...(mediaModel ? { model: mediaModel } : {})}
          />
        ))}
        {media.decks.map((deck, index) => (
          <MediaFeedCard
            key={`deck-${index}`}
            deck={deck}
            {...(mediaChatId ? { chatId: mediaChatId } : {})}
            {...(mediaModel ? { model: mediaModel } : {})}
            // Тема человека сильнее заголовка модели: искать колоду он будет по
            // тому, о чём просил.
            prompt={mediaTopic ?? deck.title}
            // Правка действует только по последнему ответу — та же причина, что
            // у разделения и продолжения выше.
            {...(isLast && mediaRevision?.reviseOf ? { reviseOf: mediaRevision.reviseOf } : {})}
            {...(isLast && mediaRevision?.onDone ? { onDeckSaved: mediaRevision.onDone } : {})}
            {...(mediaRevision ? { onRevise: mediaRevision.onStart } : {})}
          />
        ))}
        {/* Непринятый блок остаётся в тексте как есть, и решение об этом приняла
            ПАНЕЛЬ — значит, она и говорит об этом. */}
        {media.rejected > 0 && (
          <Typography variant="caption" color="danger" as="p">
            {t('chat.mode.block.rejected', { count: media.rejected })}
          </Typography>
        )}
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
          {/* Хаб родителя — первой строкой ленты, как у Claude: сперва «где
              все», потом сама переписка. Групп нет — карточки нет вовсе. */}
          {onOpenChild && (
            <ChildStages
              groups={stages ?? []}
              onOpen={onOpenChild}
              tree={tree}
              {...(onPauseAll ? { onPauseAll } : {})}
              {...(onResumeAll ? { onResumeAll } : {})}
              {...(treeBusy !== undefined ? { treeBusy } : {})}
              {...(onAnswerHold ? { onAnswerHold } : {})}
              {...(holdBusy !== undefined ? { holdBusy } : {})}
              {...(onRelease ? { onRelease } : {})}
              {...(releaseBusy !== undefined ? { releaseBusy } : {})}
              {...(onCheckOverlap ? { onCheckOverlap } : {})}
              {...(overlapBusy !== undefined ? { overlapBusy } : {})}
              foreign
            />
          )}
          {messages.map((message) =>
            /* Заметка панели — не реплика: подписывать её именем провайдера
               значило бы приписать модели слова, которых она не говорила. */
            message.role === 'notice' ? (
              <Typography
                key={message.id}
                variant="caption"
                color="subtle"
                className={styles.noticeTurn}
                data-provider-notice
              >
                {message.content}
              </Typography>
            ) : (
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
                {message.role === 'assistant' && message.contextSummarized && (
                  <ContextSummarizedNote scope="run" />
                )}
                {renderTime(message)}
              </Stack>
            ),
          )}

          {/*
            Ревью чужих MR (Т6) — под перепиской, а не над ней: это решение
            человека, а не отчёт, и место ему там же, где у Claude, — внизу
            ленты, куда человек смотрит, вернувшись к разговору.
          */}
          {onReviewDecide &&
            (reviews ?? []).map((item) => (
              <ReviewDecisionCard
                key={item.chatId}
                item={item}
                // «Ко всем» считается по СОСЕДЯМ: сколько ещё карточек дерева
                // ждут решения. Своя в счёт не идёт — иначе тумблер обещал бы
                // применить решение к самой себе.
                others={
                  (reviews ?? []).filter((other) => waitsDecision(other) && other !== item).length
                }
                onDecide={onReviewDecide}
                {...(onReviewPush ? { onPush: onReviewPush } : {})}
                {...(onReviewRetry ? { onRetry: onReviewRetry } : {})}
                {...(reviewBusy !== undefined ? { busy: reviewBusy } : {})}
              />
            ))}

          {isRunning && (
            <Stack gap="var(--spacing-3xs)" className={styles.assistantTurn}>
              <Typography variant="caption" color="subtle" as="span">
                {providerName}
              </Typography>
              {/* Тот же разбор, что и у записанной реплики: недописанный блок
                  вердикта прячется с открывающей кавычки и до конца, иначе
                  человек несколько секунд смотрит, как растёт служебный JSON. */}
              <Typography className={styles.turnText}>
                {(partial ? scanReviewBlocks(partial).text : '') || t('providerChat.thinking')}
                <span className={styles.caret}>▍</span>
              </Typography>
            </Stack>
          )}
        </Stack>
      )}
    </div>
  );
}
