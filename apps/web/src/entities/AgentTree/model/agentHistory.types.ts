import type { AgentHistorySession } from '@agentdeck/contracts/agent-history';
import type { ProgressAgent } from '@agentdeck/contracts';

/** «Сейчас: N агент · M субагентов» по частям: числа рисуются отдельно от слов. */
export interface LiveCountParts {
  agents: number;
  agentsWord: string;
  subagents: number;
  subagentsWord: string;
}

/** Сессия и её место в списке (номер «Сессия N» считается от него). */
export interface IndexedSession {
  session: AgentHistorySession;
  index: number;
}

/** Кто работает сейчас — по отметкам сессий от сервера. */
export interface LiveNow {
  /** Сессии, где главный агент работает. */
  mains: IndexedSession[];
  /** Работающие субагенты с их сессиями. */
  agents: Array<IndexedSession & { agent: ProgressAgent }>;
  /** Сессия для «главный агент не работает»: есть, только когда никто из главных не работает. */
  idle: IndexedSession | undefined;
}
