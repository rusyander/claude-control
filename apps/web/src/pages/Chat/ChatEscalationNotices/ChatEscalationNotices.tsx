import { useTranslation } from 'react-i18next';
import {
  escalationsOf,
  useChatEscalations,
  useMarkEscalationsRead,
} from '@entities/ChatGroupSettings';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import type { ChatEscalationNoticesProps } from './ChatEscalationNotices.types';
import styles from './ChatEscalationNotices.module.scss';

/**
 * Критичное от детей разделения — карточкой в ГЛАВНОМ чате дерева.
 *
 * Группы идут сами, и человек смотрит в главный чат, а не в каждого ребёнка:
 * без карточки заметка «эту миграцию нельзя катить» пролежала бы в ленте
 * ребёнка до сдачи MR. Карточка держится, пока человек не отметит прочитанное:
 * открыть чат группы — ещё не значит разобраться.
 */
export function ChatEscalationNotices({
  chatId,
  sessionId,
  onOpenChild,
}: ChatEscalationNoticesProps) {
  const { t } = useTranslation();
  const escalations = useChatEscalations();
  const markRead = useMarkEscalationsRead();
  const unread = escalationsOf(escalations.data, [chatId, sessionId]).filter(
    (entry) => !entry.read,
  );

  if (!chatId || unread.length === 0) return null;

  return (
    <section
      className={styles.card}
      data-escalation-notice={unread.length}
      aria-label={t('chat.escalation.unread', { count: unread.length })}
    >
      {unread.map((entry) => (
        <div key={entry.id} className={styles.entry}>
          <div className={styles.text}>
            <Typography variant="body-sm" weight="semibold" as="strong">
              {t('chat.escalation.title', { title: entry.childTitle })}
            </Typography>
            <Typography variant="body-sm" as="span">
              {entry.text}
            </Typography>
            <Typography variant="caption" color="subtle" as="span">
              {entry.source === 'block'
                ? t('chat.escalation.fromBlock')
                : t('chat.escalation.fromAutoPick')}
            </Typography>
          </div>
          <Button size="sm" variant="secondary" onClick={() => onOpenChild(entry.childChatId)}>
            {t('chat.escalation.open')}
          </Button>
        </div>
      ))}
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="ghost"
          isLoading={markRead.isPending}
          onClick={() => markRead.mutate({ chatId, ...(sessionId ? { sessionId } : {}) })}
        >
          {t('chat.escalation.dismiss')}
        </Button>
      </div>
    </section>
  );
}
