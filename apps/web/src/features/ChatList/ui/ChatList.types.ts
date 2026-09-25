import type { ChatSummary } from '@agentdeck/contracts';
import type { RunStatus } from '@shared/lib/agent-runs';

/** Режим поиска в списке: по названию/проекту/превью или по телу переписки. */
export type ChatSearchMode = 'title' | 'messages';

export interface ChatListProps {
  chats: ChatSummary[];
  isLoading: boolean;
  activeId?: string;
  onSelect: (chat: ChatSummary) => void;
  onCreate: () => void;
  /** Статус агента по каждому разговору: «id разговора → работает/ждёт/упал». */
  statuses?: Map<string, RunStatus>;
}

/** Строка списка: разговор и, для поиска по телу, его сниппет с числом совпадений. */
export interface ChatRowData {
  chat: ChatSummary;
  snippet?: string;
  matchCount?: number;
  /**
   * Уровень вложенности: 0 — обычный разговор, 1 — чат, выделенный из него
   * разделением задач. Глубже не бывает намеренно — порождённый чат сам делить
   * уже не даёт, и дерево не превращается в лес отступов.
   */
  depth?: number;
  /** Ветвь поднята наверх: в ней сейчас идёт прогон (см. `withActiveFirst`). */
  pinned?: boolean;
  /** Первый из снятых перезапуском детей: над ним разделитель «Неактивно». */
  inactiveStart?: boolean;
}

export type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

/** Заголовок в списке: дата или «Сейчас работают» над поднятыми ветвями. */
export type ListGroup = TimeGroup | 'running';

export type Row =
  | { kind: 'header'; group: ListGroup }
  | { kind: 'chat'; group: ListGroup; data: ChatRowData }
  /** Разделитель внутри ветви: ниже — дети, снятые перезапуском разделения. */
  | { kind: 'inactive'; group: ListGroup; parentId: string };

export interface ChatRowProps {
  chat: ChatSummary;
  isActive: boolean;
  language: string;
  onSelect: () => void;
  /** Фрагмент из тела переписки — показывается вместо превью в поиске по сообщениям. */
  snippet?: string;
  /** Сколько раз запрос встретился в переписке. */
  matchCount?: number;
  /** Запрос — для подсветки совпадений в сниппете. */
  query?: string;
  /** Статус агента этого разговора; нет прогона — нет и точки. */
  status?: RunStatus;
  /** Уровень вложенности в дереве: отступ и ветвь рисуются по нему. */
  depth?: number;
}
