import type { AskState } from '@agentdeck/contracts/core/states';
import type { AskCardAsk } from '../../model/askCommands.types';

export interface AskCardProps {
  taskId: string;
  ask: AskCardAsk;
  /** Состояние вопроса по виду ядра; `null` — вид ещё не перечитан после строки вопроса. */
  state: AskState | null;
}
