import type { SessionLocation, SessionUsage } from '@agentdeck/contracts';

export interface SessionActionsProps {
  session: SessionUsage;
}

export interface SessionWhereDetailsProps {
  location: SessionLocation;
}

export interface WhereModalProps {
  /** Сессия вне панели; нет — окно закрыто. */
  location?: SessionLocation;
  onClose: () => void;
}
