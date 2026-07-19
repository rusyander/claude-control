import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
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
export function MessageBubble({ message, onEdit, onPickOption, isRunning }: MessageBubbleProps) {
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
          if (block.type === 'text') {
            return (
              <div
                key={index}
                className={styles.text}
                // markdown-it с выключенным сырым html — теги из ответа
                // модели в разметку не попадут.
                dangerouslySetInnerHTML={{ __html: renderMarkdown(block.text) }}
              />
            );
          }

          if (block.type === 'thinking') {
            return (
              <details key={index} className={styles.thinking}>
                <summary>{t('chat.thinking')}</summary>
                <div className={styles.thinkingBody}>{block.text}</div>
              </details>
            );
          }

          if (block.type === 'tool') {
            // Вопрос с вариантами показываем карточкой, а не строкой вызова:
            // это не техническая подробность, а место, где ждут ответа.
            const questions =
              block.name === 'AskUserQuestion' ? parseQuestions(block.input) : undefined;

            if (questions)
              return (
                <QuestionCard
                  key={index}
                  questions={questions}
                  onPick={onPickOption}
                  disabled={isRunning}
                />
              );

            return (
              <details key={index} className={styles.tool}>
                <summary>{block.name}</summary>
                <div className={styles.toolInput}>{block.input}</div>
              </details>
            );
          }

          return <img key={index} src={block.source} alt="" className={styles.image} />;
        })}
      </div>
    </div>
  );
}
