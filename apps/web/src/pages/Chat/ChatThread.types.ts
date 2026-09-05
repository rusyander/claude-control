import type { ChatMessage, ChatSummary } from '@claude-control/contracts';
import type { StreamState } from '@entities/Chat';
import type { ActiveRunView, PendingPermission, QueuedMessage } from '@shared/lib/agent-runs';
import type { HandoffControls } from '@features/ChatMessages';
import type { ChildHub } from './model/useChildHub';
import type { TaskSplitApi } from './model/useTaskSplit';

/** Права и модель, с которыми уходит ответ дочернему разговору. */
export interface ChildAnswerOptions {
  allowEdits: boolean;
  autoApprove: boolean;
  model: string;
  effort: string;
}

/**
 * Середина страницы: лента переписки — либо подсказки, если говорить ещё не о
 * чем. Всё, что нужно её обработчикам, приходит сырьём (разговоры, прогоны,
 * права), а не готовыми колбэками: иначе страница снова обрастает лямбдами,
 * ради выноса которых компонент и заведён.
 */
export interface ChatThreadProps {
  /** История и оптимистичные пузыри, уже склеенные в один список. */
  messages: ChatMessage[];
  /** Разговор на экране: по его смене лента прокручивается к последнему. */
  conversationId?: string;
  stream: StreamState;
  isLoading: boolean;
  hasMore?: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onEdit: (text: string) => void;
  onPickOption: (answer: string) => Promise<boolean> | void;
  isRunning: boolean;
  /** Ключ прогона этого разговора: по нему уходят права и повтор. */
  chatId?: string;
  permissions: PendingPermission[];
  /** Дописанное, ждущее конца хода: лента рисует его пузырём-призраком. */
  queued: QueuedMessage[];
  /** Убрать сообщение из очереди, пока оно не ушло. */
  onCancelQueued: (queuedId: string) => void;
  /** Пульт детей разделения: их вопросы, права и заведённые ветки. */
  child: ChildHub;
  /** Разговоры и активные прогоны — по ним ответ ребёнку находит его чат. */
  chats: ChatSummary[];
  activeRuns: ActiveRunView[];
  childAnswerOptions: ChildAnswerOptions;
  /** Единица расхода в бейджах: токены или деньги. */
  costUnit?: 'tokens' | 'money';
  /** Глубина продумывания прошлого хода — для расшифровки цены. */
  effort?: string;
  taskSplit: TaskSplitApi;
  /** Продолжить упавший ход с места обрыва — кнопка в карточке ошибки. */
  onContinue: () => void;
  /** Перечитать переписку: поток потерян, а ответ мог дописаться в транскрипт. */
  onRefresh: () => void;
  /** Управление продолжением в чистой сессии; пусто — предлагать нечего. */
  handoff?: HandoffControls;
  /** Пустой разговор: подсказки зависят от того, проект это или песочница. */
  isProjectContext: boolean;
  projectName?: string;
  projectPath?: string;
  onOpenEditor: (path: string) => void;
  /** Щелчок по подсказке подставляет её текст в поле ввода. */
  onPickPrompt: (prompt: string) => void;
}
