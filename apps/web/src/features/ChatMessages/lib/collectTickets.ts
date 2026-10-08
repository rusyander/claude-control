import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { splitTicketKey, type SplitTicketView } from '@agentdeck/contracts/split-tickets';

/** Предложение тикета в хабе: сам дефект и группы, которые на него наткнулись. */
export interface HubTicket extends SplitTicketView {
  key: string;
  groups: string[];
}

/**
 * Предложения тикетов всех групп одним списком (95b). Сервер убирает повторы
 * внутри группы; одну и ту же находку две группы описывают одинаково часто —
 * общий дефект виден обеим, — и в списке она одна, с обеими группами.
 */
export function collectTickets(groups: SplitPlanView['groups']): HubTicket[] {
  const byKey = new Map<string, HubTicket>();
  for (const group of groups) {
    for (const ticket of group.tickets ?? []) {
      const key = splitTicketKey(ticket);
      const known = byKey.get(key);
      if (known) {
        if (!known.groups.includes(group.title)) known.groups.push(group.title);
        continue;
      }
      byKey.set(key, { ...ticket, key, groups: [group.title] });
    }
  }
  return [...byKey.values()];
}
