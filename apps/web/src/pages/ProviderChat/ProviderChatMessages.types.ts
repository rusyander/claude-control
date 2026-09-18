import type { ProviderChatMessage } from '@agentdeck/contracts';
import type { TaskSplitProposal, TaskSplitReviewDecision } from '@agentdeck/contracts/task-split';
import type { ChatTreeView, HandoffProposal } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup, ReviewDecisionItem } from '@features/ChatMessages';
import type { MediaRevision } from '@entities/Media';

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
  /**
   * Хаб родителя (Т2 партии чужих CLI): группы разделения, их звенья и
   * состояние. Собирает страница по дереву с сервера; пусто — карточки нет.
   */
  stages?: ChildStageGroup[];
  tree?: ChatTreeView;
  /** Открыть звено — тем же экраном: у чужого чата вкладок копий нет. */
  onOpenChild?: (chatId: string) => void;
  /** Остановить / продолжить всё дерево разом (Т5). */
  onPauseAll?: () => void;
  onResumeAll?: () => void;
  /** Запрос паузы или продолжения в пути — кнопка крутится, второй клик не уходит. */
  treeBusy?: boolean;
  /**
   * Ответ на вопрос разбора (Т3): группа стоит, чата у неё ещё нет, и ответ
   * уходит родителю с её номером.
   */
  onAnswerHold?: (index: number, answer: string) => void;
  holdBusy?: boolean;
  /**
   * «Отпустить» группу, которая ждёт предшественников (Т3): цепочка
   * предшественника может не кончиться никогда, и тогда это единственная дверь.
   */
  onRelease?: (index: number) => void;
  releaseBusy?: boolean;
  /**
   * Сверить ветки групп (Т4): считает сервер запросами к git, поэтому кнопка, а
   * не постоянный пересчёт. Сам результат приезжает деревом.
   */
  onCheckOverlap?: () => void;
  overlapBusy?: boolean;
  /**
   * Ревью MR по ссылке (Т6): карточки решения открытого разговора — все ревью
   * дерева у родителя, своё собственное у группы. Пусто — решать нечего.
   */
  reviews?: ReviewDecisionItem[];
  /** Решение человека; без него карточки не показываются вовсе. */
  onReviewDecide?: (chatId: string, decision: TaskSplitReviewDecision, all: boolean) => void;
  /** «Закоммитить и отправить в MR» — отдельный клик после правок. */
  onReviewPush?: (chatId: string) => void;
  reviewBusy?: boolean;
  /**
   * Разговор и его модель — ими подписана карточка вложения из блока агента
   * (Т10). Реплика чужого CLI ни того, ни другого в себе не несёт: одно знает
   * страница, второе — запись разговора.
   */
  mediaChatId?: string;
  mediaModel?: string;
  /** Тема человека из режима презентации — ею подписана колода из блока. */
  mediaTopic?: string;
  /**
   * Правка готовой колоды. У чужого CLI карточка в ленте — ЕДИНСТВЕННОЕ место,
   * откуда правку начинают: правого столбца здесь нет вовсе.
   */
  mediaRevision?: MediaRevision;
}
