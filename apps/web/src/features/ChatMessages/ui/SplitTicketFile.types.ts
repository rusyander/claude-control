import type { HubTicket } from '../lib/collectTickets';

export interface SplitTicketFileProps {
  ticket: HubTicket;
  /** Родитель разделения — адрес ручки «Завести». */
  parentChatId: string;
  /** Проект трекера; нет — заводить некуда, кнопки нет. */
  tracker?: string;
  /** Описание задачи — тот же текст, что уходит в «Копировать». */
  description: string;
}
