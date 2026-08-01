import { useTranslation } from 'react-i18next';
import { Stack } from '@shared/ui/stack';
import { Typography } from '@shared/ui/typography';
import { Button } from '@shared/ui/button';
import { Icon } from '@shared/ui/icon';
import type { ChatQueueProps } from './ChatQueue.types';
import styles from './ChatQueue.module.scss';

/**
 * Очередь дописанного: что уйдёт агенту, когда он закончит текущий ход.
 *
 * Полоска стоит над полем ввода, а не в ленте: в ленте это выглядело бы как уже
 * отправленное сообщение, хотя агент его ещё не видел. Каждое можно снять —
 * передумать до отправки человек вправе.
 */
export function ChatQueue({ items, onCancel }: ChatQueueProps) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <Stack
      direction="row"
      align="center"
      wrap
      gap="var(--spacing-2xs)"
      className={styles.queue}
      data-chat-queue
    >
      <Typography variant="caption" color="subtle" as="span">
        {t('chat.queue.title', { count: items.length })}
      </Typography>

      {items.map((item) => (
        <Stack
          as="span"
          key={item.id}
          direction="row"
          align="center"
          gap="var(--spacing-3xs)"
          className={styles.item}
        >
          <Icon name="history" size={14} />
          <Typography variant="caption" as="span" className={styles.text} title={item.prompt}>
            {item.prompt}
          </Typography>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Icon name="close" size={14} />}
            aria-label={t('chat.queue.cancel')}
            onClick={() => onCancel(item.id)}
          />
        </Stack>
      ))}
    </Stack>
  );
}
