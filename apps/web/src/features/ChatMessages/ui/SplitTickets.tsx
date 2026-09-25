import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { collectTickets, type HubTicket } from '../lib/collectTickets';
import { SplitTicketFile } from './SplitTicketFile';
import type { SplitTicketsProps } from './SplitTickets.types';
import styles from './ChildStages.module.scss';
import own from './SplitTickets.module.scss';

/**
 * «Предложить тикет» (95b): дефекты вне задач групп, которые группы описали
 * блоком тикета, одним списком в хабе.
 *
 * «Копировать» есть всегда: текст готов к вставке в форму трекера — название,
 * где, почему и какая группа нашла. Если к проекту привязан проект трекера,
 * рядом «Завести» (L277) — с подтверждением в строке: запись в трекер —
 * согласие человека на эту операцию.
 */
export function SplitTickets({ groups, parentChatId, tracker }: SplitTicketsProps) {
  const { t } = useTranslation();
  const tickets = collectTickets(groups);
  if (tickets.length === 0) return null;

  const textOf = (ticket: HubTicket): string =>
    t('chat.cascade.hub.tickets.copyText', {
      title: ticket.title,
      where: ticket.where || '—',
      why: ticket.why || '—',
      groups: ticket.groups.join(', '),
    });
  const copy = (ticket: HubTicket): void => {
    const text = textOf(ticket);
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t('chat.cascade.hub.tickets.copied')))
      .catch(() => toast.error(t('chat.cascade.hub.tickets.copyFailed')));
  };

  return (
    <div className={own.section} data-split-tickets={tickets.length}>
      <Typography
        variant="caption"
        color="subtle"
        as="div"
        title={t('chat.cascade.hub.tickets.hint')}
      >
        {t('chat.cascade.hub.tickets.title', { count: tickets.length })}
      </Typography>
      {tickets.map((ticket) => (
        <div key={ticket.key} className={own.item} data-split-ticket>
          <div className={own.body}>
            <Typography variant="body-sm" as="div">
              {ticket.title}
            </Typography>
            <Typography variant="caption" color="subtle" as="div" truncate>
              {[
                ticket.where,
                t('chat.cascade.hub.tickets.foundBy', { groups: ticket.groups.join(', ') }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
            {ticket.why && (
              <Typography variant="caption" color="subtle" as="div" className={own.why}>
                {ticket.why}
              </Typography>
            )}
          </div>
          <div className={styles.holdActions}>
            <SplitTicketFile
              ticket={ticket}
              parentChatId={parentChatId}
              description={textOf(ticket)}
              {...(tracker ? { tracker } : {})}
            />
            <Button size="sm" variant="ghost" data-copy-ticket onClick={() => copy(ticket)}>
              {t('chat.cascade.hub.tickets.copy')}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
