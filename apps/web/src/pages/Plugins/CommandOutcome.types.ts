import type { CommandResult } from '@agentdeck/contracts';

export interface CommandOutcomeProps {
  /** Итог последней команды CLI; нет — команд ещё не было, ничего не рисуем. */
  result: CommandResult | undefined;
}
