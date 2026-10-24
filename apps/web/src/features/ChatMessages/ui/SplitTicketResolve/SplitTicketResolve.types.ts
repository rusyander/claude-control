import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type {
  SplitTicketBundle,
  SplitTicketPublished,
  SplitTicketTarget,
} from '@agentdeck/contracts/split-ticket-batch';

export interface SplitTicketResolveProps {
  /** Группы записи разделения: открытые предложения считаются по ним. */
  groups: SplitPlanView['groups'];
  /** Родитель разделения — адрес ручек «Разобрать…». */
  parentChatId: string;
  /** Открыть чат «Решить здесь» в этом же окне; нет — кнопки «Решить здесь» нет. */
  onOpen?: (chatId: string) => void;
  /** Дерево ведёт чужой CLI: чат «Решить здесь» запускает только Claude. */
  foreign?: boolean;
}

/** Что окно знает о «куда заводить»: чтение идёт, не удалось или готово. */
export type TargetState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: SplitTicketTarget };

export interface SplitTicketResolveBodyProps {
  /**
   * Открытые предложения: повторы склеены в дефекты, дефекты одного файла —
   * в связки (будущие задачи). Тот же детерминированный расчёт, что у сервера.
   */
  bundles: readonly SplitTicketBundle[];
  target: TargetState;
  project: string;
  issueType: string;
  onProject: (key: string) => void;
  onIssueType: (name: string) => void;
  /** Итог публикации; есть — окно показывает его вместо выбора. */
  result?: SplitTicketPublished;
  /** Текст отказа последнего действия (публикация или «Решить здесь»). */
  error?: string;
}

export interface SplitTicketResolveActionsProps {
  /** Почему «Опубликовать» выключено; пусто — можно. */
  publishBlocked?: string;
  publishing: boolean;
  taking: boolean;
  /** Показывать ли «Решить здесь» (свой CLI и есть куда открыть чат). */
  canTake: boolean;
  /** Jira не подключена — рядом кнопка «Подключить Jira». */
  offline: boolean;
  result?: SplitTicketPublished;
  onPublish: () => void;
  onRetry: () => void;
  onTake: () => void;
  onConnect: () => void;
  onClose: () => void;
}
