import { SplitHumanSteps } from '../SplitHumanSteps/SplitHumanSteps';
import { SplitTickets } from '../SplitTickets/SplitTickets';
import type { SplitFollowUpsProps } from './SplitFollowUps.types';

/**
 * Что после работы групп осталось человеку. Шаги, которые группы сделать не
 * могут (находка 112), — первыми: без них доставка не закончена. Дефекты вне
 * задач групп (95b) — следом: это уже новая работа.
 */
export function SplitFollowUps({
  split,
  defaultExpanded = false,
  onOpen,
  foreign,
}: SplitFollowUpsProps) {
  return (
    <>
      <SplitHumanSteps groups={split.groups} defaultExpanded={defaultExpanded} />
      <SplitTickets
        groups={split.groups}
        parentChatId={split.parentChatId}
        defaultExpanded={defaultExpanded}
        {...(split.ticketTracker ? { tracker: split.ticketTracker } : {})}
        {...(onOpen ? { onOpen } : {})}
        {...(foreign !== undefined ? { foreign } : {})}
      />
    </>
  );
}
