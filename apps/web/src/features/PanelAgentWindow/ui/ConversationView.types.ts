import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import type { PanelAgentSession } from '../model/usePanelAgentSession';

export interface ConversationViewProps {
  session: PanelAgentSession;
  pending: PanelPendingAction[];
  /** Карточки, по которым клик уже отправлен и ждёт кадра итога. */
  deciding: ReadonlySet<string>;
  decideErrors: Record<string, string>;
  /** Карточки, одобрение которых сервер отклонил как неполные (409 `preview_truncated`). */
  approveRefused: ReadonlySet<string>;
  onDecide: (id: string, decision: 'approve' | 'reject') => void;
  /** Раздел, где стоит человек, словами. */
  pageLabel: string;
  projectLabel?: string;
  onSend: (text: string) => void;
}
