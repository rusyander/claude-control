import type { PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { api } from '../../shared/api/client';

/** Ждущие карточки — отдельно от хука: тем же вызовом ходит живая проверка. */
export function fetchPanelAgentPending(): Promise<PanelPendingAction[]> {
  return api.get<PanelPendingAction[]>('/agent/pending');
}
