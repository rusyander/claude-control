import type { ChatSummary } from '@claude-control/contracts';
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
}

export type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

export type Row =
  { kind: 'header'; group: TimeGroup } | { kind: 'chat'; group: TimeGroup; data: ChatRowData };

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
}
