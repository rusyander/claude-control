import type { ClaudeLocation } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function setLocation(path: string): Promise<ClaudeLocation> {
  const { data } = await apiClient.post<ClaudeLocation>('/location', { path });
  return data;
}
