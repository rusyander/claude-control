import type { PanelPendingDecision } from '@agentdeck/contracts/panel-agent';
import { api } from '../../shared/api/client';

/**
 * Решение по карточке. Ответ — `{ok:true}`: итог приходит в след и в ход агента,
 * поэтому после ответа перечитываются карточки и след.
 */
export function decidePanelAction(id: string, decision: PanelPendingDecision['decision']) {
  return api.post<{ ok: true }>(`/agent/pending/${encodeURIComponent(id)}`, { decision });
}
