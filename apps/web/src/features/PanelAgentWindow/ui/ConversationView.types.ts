import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
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
  /** Отправка реплики; картинки — блоками в самом запросе хода. */
  onSend: (text: string, images: AgentImage[]) => void;
  /** Открыть другой разговор — у карточки, которую просил он. */
  onOpenConversation?: (id: string) => void;
}
