import { SplitHumanSteps } from './SplitHumanSteps';
import { SplitTickets } from './SplitTickets';
import type { SplitFollowUpsProps } from './SplitFollowUps.types';

/**
 * Что после работы групп осталось человеку. Шаги, которые группы сделать не
 * могут (находка 112), — первыми: без них доставка не закончена. Дефекты вне
 * задач групп (95b) — следом: это уже новая работа.
 */
export function SplitFollowUps({ split }: SplitFollowUpsProps) {
  return (
    <>
      <SplitHumanSteps groups={split.groups} />
      <SplitTickets
        groups={split.groups}
        parentChatId={split.parentChatId}
        {...(split.ticketTracker ? { tracker: split.ticketTracker } : {})}
      />
    </>
  );
}
