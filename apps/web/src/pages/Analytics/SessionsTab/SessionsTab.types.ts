import type { SessionUsage } from '@agentdeck/contracts';

export interface SessionsTabProps {
  sessions: SessionUsage[];
  locale: string;
  /** Чьи сессии: у чужого CLI нет заметки о лимитах подписки Claude. */
  providerId?: string;
}
