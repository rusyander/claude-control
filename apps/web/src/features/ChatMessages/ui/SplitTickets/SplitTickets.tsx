import { useTranslation } from 'react-i18next';
import { Button } from '@shared/ui/button';
import { Typography } from '@shared/ui/typography';
import { toast } from '@shared/lib/toast';
import { collectTickets, type HubTicket } from '../../lib/collectTickets';
import { SplitTicketFile } from '../SplitTicketFile/SplitTicketFile';
import { HubFold } from '../HubFold/HubFold';
import { SplitTicketResolve } from '../SplitTicketResolve/SplitTicketResolve';
import type { SplitTicketsProps } from './SplitTickets.types';
import own from './SplitTickets.module.scss';

/**
 * «Предложить тикет» (95b): дефекты вне задач групп, которые группы описали
 * блоком тикета, одним списком в хабе.
 *
 * «Копировать» есть всегда: текст готов к вставке в форму трекера — название,
 * где, почему и какая группа нашла. Если к проекту привязан проект трекера,
 * рядом «Завести» (L277) — с подтверждением в строке: запись в трекер —
 * согласие человека на эту операцию.
 *
 * «Разобрать…» в заголовке (владелец 24.10.2026) — все открытые предложения
 * разом: опубликовать в Jira одной кнопкой или решить в новом чате. Взятое в
 * чат показывает ссылку на этот чат вместо «Завести».
 */
export function SplitTickets({
  groups,
  parentChatId,
  tracker,
  defaultExpanded = false,
  onOpen,
  foreign,
}: SplitTicketsProps) {
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
      <HubFold
        title={t('chat.cascade.hub.tickets.title', { count: tickets.length })}
        hint={t('chat.cascade.hub.tickets.hint')}
        defaultExpanded={defaultExpanded}
        actions={
          <SplitTicketResolve
            groups={groups}
            parentChatId={parentChatId}
            {...(onOpen ? { onOpen } : {})}
            {...(foreign !== undefined ? { foreign } : {})}
          />
        }
      >
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
            <div className={own.holdActions}>
              {ticket.taken && !ticket.filed ? (
                <Button
                  size="sm"
                  variant="ghost"
                  data-ticket-taken={ticket.taken.chatId}
                  disabled={!onOpen}
                  onClick={() => onOpen?.(ticket.taken?.chatId ?? '')}
                >
                  {t('chat.cascade.hub.tickets.taken')}
                </Button>
              ) : (
                <SplitTicketFile
                  ticket={ticket}
                  parentChatId={parentChatId}
                  description={textOf(ticket)}
                  {...(tracker ? { tracker } : {})}
                />
              )}
              <Button size="sm" variant="ghost" data-copy-ticket onClick={() => copy(ticket)}>
                {t('chat.cascade.hub.tickets.copy')}
              </Button>
            </div>
          </div>
        ))}
      </HubFold>
    </div>
  );
}
