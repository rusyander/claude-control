import { apiClient } from '@shared/api/client';

/** Состояние цепочки разговора: тумблер, номер шага и потолок. */
export interface HandoffState {
  auto: boolean;
  depth: number;
  maxChain: number;
}

export async function fetchHandoffState(keys: {
  chatId?: string;
  sessionId?: string;
}): Promise<HandoffState> {
  const { data } = await apiClient.get<HandoffState>('/chat/handoff/state', { params: keys });
  return data;
}
