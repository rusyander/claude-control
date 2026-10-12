import type { LogEntry, LogSource, LogsSources } from '@entities/Logs';
import type { LogLevel } from '../../lib/logParse';
import type { LogRow } from '../../lib/logView';

export interface LogsPanelProps {
  projectPath: string;
  isOpen: boolean;
  /** Положить просьбу агенту в поле чата и закрыть окно. Нет — кнопки «Разобрать в чате» нет. */
  onAskAgent?: (text: string) => void;
}

export interface LogSourceListProps {
  info: LogsSources;
  selectedId?: string;
  onSelect: (sourceId: string) => void;
}

export interface LogSourceViewProps {
  projectPath: string;
  isOpen: boolean;
  source: LogSource;
  search: string;
  onSearchChange: (value: string) => void;
  level?: LogLevel;
  onLevelChange: (level: LogLevel | undefined) => void;
  /** Источник пропал (сервис удалён, цель ушла из списка) — перечитать список. */
  onSourceGone: () => void;
  onAskAgent?: (text: string) => void;
}

export interface LogToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Сколько строк видно и сколько всего — рядом с поиском. */
  shown: number;
  total: number;
  level?: LogLevel;
  onLevelChange: (level: LogLevel | undefined) => void;
  /** Сколько строк покажет каждый порог. */
  counts: Record<LogLevel, number>;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  onClear: () => void;
}

export interface LogViewProps {
  label: string;
  rows: LogRow[];
  search: string;
  /** У источника «все сервисы» строка подписана сервисом. */
  showService: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  selectedId?: number;
  onSelect: (id: number | undefined) => void;
  onAsk?: (entry: LogEntry) => void;
}

export interface LogLineRowProps {
  row: LogRow;
  search: string;
  showService: boolean;
  time?: string;
  isSelected: boolean;
  onToggle: () => void;
  onAsk?: () => void;
}
