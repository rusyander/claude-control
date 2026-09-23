import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { toast } from '@shared/lib/toast';
import { scanSplitBlocks } from '@agentdeck/contracts/task-split';
import { scanHandoffBlocks } from '@agentdeck/contracts/chat-handoff';
import { scanReviewBlocks } from '@agentdeck/contracts/model-cascade';
import { scanPlanBlocks, scanSplitPlanBlocks } from '@agentdeck/contracts/split-plan';
import { scanMediaBlocks } from '@agentdeck/contracts/media-block';
import { attachmentBasename, splitAttachments } from '@agentdeck/contracts/uploads';
import { markQuestionAnswered, useAnsweredQuestions } from '@shared/lib/agent-runs';
import { ContextSummarizedNote } from '@entities/Platform';
import { parseQuestions } from '../lib/parseQuestions';
import { questionKey } from '../lib/questionKey';
import { taskNoticesOf } from '../lib/taskNotice';
import { QuestionCard } from './QuestionCard';
import { TaskSplitCard } from './TaskSplitCard';
import { HandoffCard } from './HandoffCard';
import { ReviewCard } from './ReviewCard';
import { TriageCard } from './TriageCard';
import { PlanCard } from './PlanCard';
import { MediaFeedCard } from './MediaFeedCard';
import type { MessageBubbleProps } from './ChatMessages.types';
import styles from './ChatMessages.module.scss';

/** Статус фоновой команды из уведомления CLI → своя строка. */
const TASK_NOTICE_LABEL: Record<string, string> = {
  completed: 'chat.taskNotice.completed',
  failed: 'chat.taskNotice.failed',
  killed: 'chat.taskNotice.killed',
};

/**
 * Одно сообщение. Реплики человека выделены фоном, ответы модели идут во всю
 * ширину колонки. Размышления и вызовы инструментов свёрнуты: их бывает
 * десятки на один ответ, и развёрнутыми они топят сам ответ.
 */
export function MessageBubble({
  message,
  onEdit,
  onPickOption,
  isLast,
  isQuestionOpen,
  isRunning,
  costUnit,
  timing,
  onSplit,
  onKeepHere,
  isSplitPending,
  splitCeiling,
  childBranches,
  handoff,
  mediaChatId,
  mediaModel,
  mediaTopic,
  mediaRevision,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';
  // Отвеченные вопросы помнит стор: своё «отправлено» карточки не переживает
  // ухода на другую вкладку, а вопрос из транскрипта — переживает.
  const answered = useAnsweredQuestions();

  const plainText = useMemo(
    () =>
      message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n\n'),
    [message.blocks],
  );

  // К какому блоку отнести расход. Модель считает его на всё сообщение целиком,
  // а не на отдельный блок, поэтому цифра ставится там, где читается как цена
  // ДЕЙСТВИЯ: у последнего вызова инструмента, а если вызовов не было — у
  // текста, то есть у самого ответа. Размазывать одно число по всем блокам
  // нельзя: получилось бы несколько бейджей на один и тот же расход.
  const spendIndex = useMemo(() => {
    const lastTool = message.blocks.map((block) => block.type).lastIndexOf('tool');
    if (lastTool >= 0) return lastTool;
    return message.blocks.map((block) => block.type).lastIndexOf('text');
  }, [message.blocks]);

  // Сколько вызовов разделили этот расход — говорим об этом в разбивке.
  const toolCount = message.blocks.filter((block) => block.type === 'tool').length;

  // Уведомление CLI о фоновой команде — строка состояния, а не пузырь человека:
  // ни копировать, ни «изменить и отправить» здесь нечего.
  const notices = useMemo(() => taskNoticesOf(message), [message]);
  if (notices) {
    return (
      <div className={styles.row}>
        <div className={styles.taskNotice} role="status">
          {notices.map((notice, index) => (
            <div key={index} className={styles.taskNoticeLine}>
              <Icon name={notice.status === 'completed' ? 'check' : 'warning'} size={16} />
              <span>{t(TASK_NOTICE_LABEL[notice.status] ?? 'chat.taskNotice.other')}</span>
              {notice.summary && <span className={styles.taskNoticeSummary}>{notice.summary}</span>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`${styles.row} ${isUser ? styles.rowUser : ''}`}>
      <div className={`${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant}`}>
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="copy" size={20} />}
            aria-label={t('chat.copyMessage')}
            onClick={() =>
              void navigator.clipboard.writeText(plainText).then(() => {
                toast.success(t('toasts.copied'));
              })
            }
          />
          {isUser && (
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<Icon name="edit" size={20} />}
              aria-label={t('chat.editMessage')}
              onClick={() => onEdit(plainText)}
            />
          )}
        </div>

        {message.blocks.map((block, index) => {
          // Правая колонка блока: расход этого шага стоит ровно у своего
          // действия, а не общей строкой под ответом.
          const spend =
            message.usage && index === spendIndex ? (
              <TokenBadge
                usage={message.usage}
                unit={costUnit}
                sharedWith={toolCount}
                label={block.type === 'tool' ? block.name : t('chat.usage.answer')}
                durationMs={timing?.stepMs}
                from={timing?.from}
                to={timing?.to}
                runTotalMs={timing?.runTotalMs}
                className={styles.spend}
              />
            ) : null;

          if (block.type === 'text') {
            // Предложения панели приходят блоками кода внутри текста. Показываем
            // их карточками, а сами блоки из текста убираем: сырой JSON в ленте
            // не читается, а решение принимается по составу, не по формату.
            // Порядок разборов не важен — языки блоков разные, и каждый скан
            // видит только свой.
            const split = scanSplitBlocks(block.text);
            const handoffScan = scanHandoffBlocks(split.text);
            const review = scanReviewBlocks(handoffScan.text);
            // Уровни разделения (Т1): блок разбора и блок плана группы.
            const triage = scanSplitPlanBlocks(review.text);
            const plan = scanPlanBlocks(triage.text);
            // Вложения агента (Т10): рисунок и колода приезжают блоками, и
            // карточка встаёт на их место в самой ленте — эта дорога есть у
            // любого CLI, а результат её остаётся частью разговора.
            const media = scanMediaBlocks(plan.text);
            // Список путей вложений дописывает сервер, а не человек: в пузыре он
            // читался как сырой перечень абсолютных путей. Показываем чипами с
            // именем файла; сам текст для копирования и правки (`plainText`)
            // остаётся полным — агент получал именно его.
            const attachments = isUser ? splitAttachments(media.text) : undefined;
            const bodyText = attachments ? attachments.text : media.text;

            return (
              <div key={index} className={styles.block}>
                {/* Текст и карточки — одной колонкой: соседом карточка попадала
                    в колонку расхода и сжималась в узкий столбик. */}
                <div className={styles.blockBody}>
                  {bodyText && (
                    <div
                      className={styles.text}
                      // markdown-it с выключенным сырым html — теги из ответа
                      // модели в разметку не попадут.
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyText) }}
                    />
                  )}
                  {attachments && attachments.files.length > 0 && (
                    <ul className={styles.attachments} aria-label={t('chat.attachments')}>
                      {attachments.files.map((path) => (
                        <li key={path} className={styles.attachment} title={path}>
                          <Icon name="paperclip" size={14} />
                          {attachmentBasename(path)}
                        </li>
                      ))}
                    </ul>
                  )}
                  {split.proposals.map((proposal, position) => (
                    <TaskSplitCard
                      key={position}
                      proposal={proposal}
                      // Делить можно только по ПОСЛЕДНЕМУ предложению: карточка
                      // из середины истории давно отработана, и заводить по ней
                      // ветки десять ходов спустя никто не просил.
                      onSplit={isLast ? (options) => onSplit?.(proposal, options) : undefined}
                      onKeepHere={isLast ? onKeepHere : undefined}
                      isPending={isSplitPending}
                      ceiling={splitCeiling}
                      disabled={isRunning}
                      childBranches={childBranches}
                    />
                  ))}
                  {/* Блок предложения, который панель не поняла, остаётся выше
                      текстом — и без этой строки человек видит простыню JSON, не
                      понимая, что кнопок нет из-за ОТКАЗА разбора, а не потому
                      что агент так решил написать. */}
                  {split.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.split.notParsed')}
                    </div>
                  )}
                  {handoffScan.proposals.map((proposal, position) => (
                    <HandoffCard
                      key={position}
                      proposal={proposal}
                      // Ровно та же причина, что и у разделения: продолжать
                      // можно только по последнему предложению — карточка из
                      // середины истории отработана десять ходов назад.
                      {...(isLast && handoff
                        ? {
                            onContinue: (options: { startRun: boolean }) =>
                              handoff.onContinue(proposal, options),
                            onKeepHere: handoff.onKeepHere,
                            auto: handoff.auto,
                            onAutoChange: handoff.onAutoChange,
                            chainDepth: handoff.chainDepth,
                            maxChain: handoff.maxChain,
                            isPending: handoff.isPending,
                          }
                        : {})}
                      disabled={isRunning}
                    />
                  ))}
                  {/* Та же строка и по той же причине, что у разделения выше:
                      непонятый блок остаётся текстом, и без объяснения человек
                      видит JSON без единой кнопки и считает это поломкой. */}
                  {handoffScan.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.handoff.notParsed')}
                    </div>
                  )}
                  {/* Вердикт ревью: решать по нему нечего — звено правок панель
                      завела сама, — но прочитать состав человек вправе, и он же
                      единственный, кто увидит «замечаний нет». */}
                  {review.findings && <ReviewCard findings={review.findings} />}
                  {review.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.cascade.review.notParsed')}
                    </div>
                  )}
                  {/* Разбор и план (Т1): решать по ним нечего — конвейер уже
                      применил разбор и заведёт работу по плану, — но прочитать,
                      что именно панель приняла, человек вправе. */}
                  {triage.plan && <TriageCard plan={triage.plan} />}
                  {triage.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.cascade.triage.notParsed')}
                    </div>
                  )}
                  {plan.plan && <PlanCard plan={plan.plan} />}
                  {media.pictures.map((svg, position) => (
                    <MediaFeedCard
                      key={`svg-${position}`}
                      svg={svg}
                      {...(mediaChatId ? { chatId: mediaChatId } : {})}
                      {...(mediaModel ? { model: mediaModel } : {})}
                    />
                  ))}
                  {media.decks.map((deck, position) => (
                    <MediaFeedCard
                      key={`deck-${position}`}
                      deck={deck}
                      {...(mediaChatId ? { chatId: mediaChatId } : {})}
                      {...(mediaModel ? { model: mediaModel } : {})}
                      // Тема человека сильнее заголовка модели: заголовок
                      // придумала она, а искать колоду человек будет по тому, о
                      // чём просил.
                      prompt={mediaTopic ?? deck.title}
                      // Правка действует только по ПОСЛЕДНЕМУ ответу: блок из
                      // середины истории заменил бы колоду десять ходов спустя.
                      {...(isLast && mediaRevision?.reviseOf
                        ? { reviseOf: mediaRevision.reviseOf }
                        : {})}
                      {...(isLast && mediaRevision?.onDone
                        ? { onDeckSaved: mediaRevision.onDone }
                        : {})}
                      {...(mediaRevision ? { onRevise: mediaRevision.onStart } : {})}
                    />
                  ))}
                  {/* Непринятый блок остаётся в тексте как есть, и решение об
                      этом приняла ПАНЕЛЬ — значит, она и говорит об этом: иначе
                      сырой SVG в ленте читается как поломка агента. */}
                  {media.rejected > 0 && (
                    <div className={styles.splitRejected} role="status">
                      {t('chat.mode.block.rejected', { count: media.rejected })}
                    </div>
                  )}
                </div>
                {spend}
              </div>
            );
          }

          if (block.type === 'thinking') {
            return (
              <div key={index} className={styles.block}>
                <details className={styles.thinking}>
                  <summary>{t('chat.thinking')}</summary>
                  <div className={styles.thinkingBody}>{block.text}</div>
                </details>
                {spend}
              </div>
            );
          }

          if (block.type === 'tool') {
            // Вопрос с вариантами показываем карточкой, а не строкой вызова:
            // это не техническая подробность, а место, где ждут ответа.
            const questions =
              block.name === 'AskUserQuestion' ? parseQuestions(block.input) : undefined;

            if (questions) {
              // Имя вопроса: у блока транскрипта своего идентификатора нет,
              // поэтому берём сообщение и номер блока в нём.
              const key = questionKey(message.id, String(index));
              return (
                <div key={index} className={styles.block}>
                  {/*
                    Отвечать можно, пока вопрос ОТКРЫТ, — а закрывает его ответ
                    человека, не следующая реплика агента. В пакетном режиме
                    вызов `AskUserQuestion` сразу возвращается ошибкой, агент
                    спрашивает посреди хода и продолжает писать ещё минуту:
                    привязка к последнему сообщению отбирала кнопки через
                    несколько секунд, посреди наполовину заполненной формы.
                    Вопрос из середины истории по-прежнему только для чтения —
                    после него человек уже говорил.

                    «Идёт прогон» карточку тоже не гасит: занятому агенту ответ
                    уходит в очередь и доедет, как только он закончит ход.
                  */}
                  <QuestionCard
                    questions={questions}
                    onPick={
                      onPickOption && (isLast || isQuestionOpen)
                        ? (answer) => {
                            markQuestionAnswered(key);
                            onPickOption(answer);
                          }
                        : undefined
                    }
                    busy={isRunning}
                    isAnswered={answered.has(key)}
                    // Закрыт вопрос репликой человека — значит, ответ дошёл.
                    isDelivered={!isQuestionOpen && !isLast}
                  />
                  {spend}
                </div>
              );
            }

            return (
              <div key={index} className={styles.block}>
                <details className={styles.tool}>
                  <summary>{block.name}</summary>
                  <div className={styles.toolInput}>{block.input}</div>
                </details>
                {spend}
              </div>
            );
          }

          return (
            <div key={index} className={styles.block}>
              <img src={block.source} alt="" className={styles.image} />
              {spend}
            </div>
          );
        })}
        {/* Контур сжал историю перед этим ответом (`context-managed`): без
            подписи ответ читается как ответ модели, видевшей весь разговор. */}
        {!isUser && message.contextSummarized && <ContextSummarizedNote scope="answer" />}
      </div>
    </div>
  );
}
