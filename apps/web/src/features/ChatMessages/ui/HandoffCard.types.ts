import type { HandoffProposal } from '@claude-control/contracts/chat-handoff';

export interface HandoffCardProps {
  proposal: HandoffProposal;
  /** Продолжить в чистой сессии. Нет — карточка только для чтения (история). */
  onContinue?: (options: { startRun: boolean }) => void;
  /** Остаться в этом разговоре: отказ уходит агенту обычной репликой. */
  onKeepHere?: () => void;
  /** Тумблер «дальше продолжай сам» этого разговора; нет — тумблер не показываем. */
  auto?: boolean;
  onAutoChange?: (auto: boolean) => void;
  /** Какой это шаг цепочки и где её потолок — чтобы автомат не был бесконечным. */
  chainDepth?: number;
  maxChain?: number;
  /** Новый разговор заводится прямо сейчас. */
  isPending?: boolean;
  /** Идёт прогон — решать рано. */
  disabled?: boolean;
}
