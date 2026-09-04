import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { toast } from '@shared/lib/toast';
import { scanSplitBlocks } from '@claude-control/contracts/task-split';
import { scanHandoffBlocks } from '@claude-control/contracts/chat-handoff';
import { parseQuestions } from '../lib/parseQuestions';
import { QuestionCard } from './QuestionCard';
import { TaskSplitCard } from './TaskSplitCard';
import { HandoffCard } from './HandoffCard';
import type { MessageBubbleProps } from './ChatMessages.types';
import styles from './ChatMessages.module.scss';

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
  onSplit,
  onKeepHere,
  isSplitPending,
  childBranches,
  handoff,
}: MessageBubbleProps) {
  const { t } = useTranslation();
  const isUser = message.role === 'user';

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

            return (
              <div key={index} className={styles.block}>
                {/* Текст и карточки — одной колонкой: соседом карточка попадала
                    в колонку расхода и сжималась в узкий столбик. */}
                <div className={styles.blockBody}>
                  {handoffScan.text && (
                    <div
                      className={styles.text}
                      // markdown-it с выключенным сырым html — теги из ответа
                      // модели в разметку не попадут.
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(handoffScan.text) }}
                    />
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

            if (questions)
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
                    onPick={isLast || isQuestionOpen ? onPickOption : undefined}
                    busy={isRunning}
                  />
                  {spend}
                </div>
              );

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
      </div>
    </div>
  );
}
