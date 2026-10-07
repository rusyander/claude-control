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
 *
 * Сообщение, переданное агенту на ходу (`steered`), подписано иначе: оно уже у
 * агента, отменять нечего, а обычной репликой оно станет с концом хода.
 */
/** Подпись под пузырём: передаётся, передано на ходу, уйдёт следующим или следом. */
function footKey(
  item: { steered?: boolean; sending?: boolean },
  queueIndex: number,
  held: boolean,
): string {
  if (item.sending) return 'chat.queue.sending';
  if (item.steered) return 'chat.queue.steered';
  // Стоящая очередь не «уйдёт следующей» — без кнопки она не уйдёт вовсе.
  if (held) return queueIndex === 0 ? 'chat.queue.held' : 'chat.queue.later';
  return queueIndex === 0 ? 'chat.queue.next' : 'chat.queue.later';
}

export function QueuedBubbles({ items, onCancel, held = false, onSend }: QueuedBubblesProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <>
      {items.map((item, index) => {
        const queueIndex = index - items.filter((other) => other.steered || other.sending).length;
        return (
          <div key={item.id} className={`${styles.row} ${styles.rowUser}`}>
            <div
              className={`${styles.bubble} ${styles.bubbleQueued}`}
              data-queued-message
              {...(item.sending ? { 'data-steer-sending': true } : {})}
            >
              <div className={styles.queuedText}>{item.prompt}</div>
              <div className={styles.queuedFoot}>
                <Typography as="span" variant="caption" color="subtle">
                  {t(footKey(item, queueIndex, held))}
                </Typography>
                {held && onSend && queueIndex === 0 && !item.steered && !item.sending && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-queued-send
                    onClick={() => onSend(item.id)}
                  >
                    {t('chat.queue.sendHeld')}
                  </Button>
                )}
                {onCancel && !item.steered && !item.sending && (
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
        );
      })}
    </>
  );
}
