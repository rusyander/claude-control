import type { ProviderChatMessage } from '@claude-control/contracts';
import type { TaskSplitProposal } from '@claude-control/contracts/task-split';
import type { HandoffProposal } from '@claude-control/contracts/chat-handoff';

export interface ProviderChatMessagesProps {
  messages: ProviderChatMessage[];
  providerName: string;
  /** Текст, напечатанный к этому моменту: показывается отдельной репликой. */
  partial: string;
  isRunning: boolean;
  /** Нет разговоров вовсе — подсказка отличается от «разговор пустой». */
  isEmptyState: boolean;
  /** Начать разговор прямо из пустого экрана. */
  onCreate: () => void;
  isCreating: boolean;
  /**
   * Согласиться на разделение задач по чатам. Пусто — у разговора нет рабочего
   * каталога, а без него нечего делить: копии заводятся в репозитории.
   */
  onSplit?: (proposal: TaskSplitProposal, options: { startRuns: boolean }) => void;
  /** Отказаться от разделения — продолжаем в этом же разговоре. */
  onKeepHere?: () => void;
  isSplitPending?: boolean;
  /**
   * Продолжить работу в чистой сессии. Пусто по той же причине, что и у
   * разделения: без рабочего каталога новую сессию заводить негде.
   */
  onHandoff?: (proposal: HandoffProposal, options: { startRun: boolean }) => void;
  /** Отказаться от продолжения — остаёмся в этом разговоре. */
  onHandoffKeepHere?: () => void;
  isHandoffPending?: boolean;
}
