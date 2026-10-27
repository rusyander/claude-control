import type { ReactNode } from 'react';
import type {
  ChatProgress,
  ProgressAgent,
  ProgressShell,
  ProgressTask,
} from '@agentdeck/contracts';

export interface ChatProgressSheetProps {
  /** Разговор, чей это прогресс: адрес хода субагента и его остановки. */
  chatId?: string;
  progress?: ChatProgress;
  /** Агент ещё работает — показываем это в шапке панели. */
  isRunning?: boolean;
  /** Ход кончился вопросом человеку, и ответа ещё нет. */
  awaiting?: boolean;
}

export interface TaskRowProps {
  task: ProgressTask;
}

export interface AgentRowProps {
  agent: ProgressAgent;
  /** Ход ещё идёт. */
  isRunning: boolean;
  /** Жив ли процесс CLI разговора: нет — «работающий» субагент умер вместе с ним. */
  processAlive?: boolean;
  /** Текущее время — для «писал N назад». */
  now: number;
  /** Узел дерева: его глубина, фокус и раскрытие. Нет — строка вне дерева. */
  tree?: AgentRowTree;
  /** Ветка вложенных субагентов — внутри узла, как требует ARIA-дерево. */
  children?: ReactNode;
}

export interface AgentRowTree {
  level: number;
  /** У узла есть вложенные: раскрыт ли он. Нет вложенных — `undefined`. */
  expanded?: boolean;
  /** Остановка Tab дерева — ровно один узел. */
  isTabStop: boolean;
  /** Открыт справа именно его ход. */
  isSelected: boolean;
  onToggle: () => void;
  /** Открыть ход справа; нет — у узла нет файла субагента. */
  onOpen?: () => void;
  /** «Остановить»; нет — остановить нечем или незачем. */
  onStop?: () => void;
  /** Окно «Скиллы, хуки и MCP» этого субагента; нет — у узла нет файла. */
  onExtensions?: () => void;
  isStopping: boolean;
  /** Итог последнего «Остановить» одной строкой. */
  stopNote?: string;
}

export interface AgentTreeProps {
  /** Разговор, чьи это субагенты: адрес их хода и остановки. */
  chatId?: string;
  agents: ProgressAgent[];
  isRunning: boolean;
  processAlive?: boolean;
  /** У разговора есть живой процесс CLI — «Остановить» доходит до него. */
  canStop: boolean;
  now: number;
  /** Открыть окно «Скиллы, хуки и MCP» на субагенте с этим id. */
  onExtensions?: (agentId: string) => void;
}

export interface ShellRowProps {
  shell: ProgressShell;
  /** Ход ещё идёт. */
  isRunning: boolean;
  /** Жив ли процесс CLI разговора: нет — «идущая» команда умерла вместе с ним. */
  processAlive?: boolean;
  /** Текущее время для таймера — один на всю панель. */
  now: number;
}
