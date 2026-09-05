import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { QueuedBubblesProps } from './QueuedBubbles.types';
import styles from './ChatMessages.module.scss';

/**
 * Дописанное, пока агент занят, — прямо в ленте, там же, где будет стоять,
 * когда уйдёт.
 *
 * До этого очередь была видна одной полоской над полем ввода, и человек, ответив
 * на вопрос занятому агенту, не видел в ленте НИЧЕГО: ни своей реплики, ни следа
 * ответа — минутами непонятно, ушло ли. Пузырь-призрак говорит и что сообщение
 * принято, и что оно ещё не отправлено: он бледный, пунктирный, с подписью
 * «уйдёт следующим» и кнопкой «убрать», пока не поздно.
 *
 * Дубля не будет: как только сообщение уходит, оно покидает очередь — и пузырь
 * вместе с ней, — а в ленте появляется обычной репликой.
 */
export function QueuedBubbles({ items, onCancel }: QueuedBubblesProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <>
      {items.map((item, index) => (
        <div key={item.id} className={`${styles.row} ${styles.rowUser}`}>
          <div className={`${styles.bubble} ${styles.bubbleQueued}`} data-queued-message>
            <div className={styles.queuedText}>{item.prompt}</div>
            <div className={styles.queuedFoot}>
              <Typography as="span" variant="caption" color="subtle">
                {index === 0 ? t('chat.queue.next') : t('chat.queue.later')}
              </Typography>
              {onCancel && (
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={<Icon name="close" size={14} />}
                  aria-label={t('chat.queue.cancel')}
                  onClick={() => onCancel(item.id)}
                />
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  );
}
