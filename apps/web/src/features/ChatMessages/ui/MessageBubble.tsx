import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { TokenBadge } from '@shared/ui/token-badge';
import { renderMarkdown } from '@shared/lib/markdown/renderMarkdown';
import { toast } from '@shared/lib/toast';
import { QuestionCard, parseQuestions } from './QuestionCard';
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
  isRunning,
  costUnit,
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
            return (
              <div key={index} className={styles.block}>
                <div
                  className={styles.text}
                  // markdown-it с выключенным сырым html — теги из ответа
                  // модели в разметку не попадут.
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
                />
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
                  <QuestionCard questions={questions} onPick={onPickOption} disabled={isRunning} />
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
