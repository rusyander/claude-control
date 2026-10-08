import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import { Typography } from '@shared/ui/typography';
import type { QueuedBubblesProps } from './QueuedBubbles.types';
import styles from './QueuedBubbles.module.scss';
import { footKey } from '../../lib/footKey';

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
