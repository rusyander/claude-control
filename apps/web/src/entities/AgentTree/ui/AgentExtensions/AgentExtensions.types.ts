import type { AgentExtensions, AgentExtensionSummary, ProgressAgent } from '@agentdeck/contracts';

export interface ExtensionTimelineProps {
  /** Хронология агента; нет — читается или не нашлась. */
  data: AgentExtensions | undefined;
  isLoading: boolean;
}

export interface ExtensionChipsProps {
  summary: readonly AgentExtensionSummary[] | undefined;
  /** Открыть окно «Скиллы, хуки и MCP» этого агента; нет — значки без кнопки. */
  onOpen?: () => void;
  /** Подпись кнопки для чтения с экрана. */
  openLabel?: string;
  className?: string;
}

export interface AgentExtensionsModalProps {
  chatId: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  /** Субагенты разговора — те, у кого есть файл (`agentId`), попадают в список. */
  agents: readonly ProgressAgent[];
  /** Сводка главного агента — из прогресса разговора. */
  mainSummary?: readonly AgentExtensionSummary[] | undefined;
  /** С какого агента открыть: id субагента; нет — главный. */
  initialAgentId?: string | undefined;
  /** Прогон идёт — окно перечитывает хронологию. */
  isRunning: boolean;
}
