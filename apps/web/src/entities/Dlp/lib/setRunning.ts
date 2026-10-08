import type { DlpInfo } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function setRunning(running: boolean): Promise<DlpInfo> {
  const { data } = await apiClient.post<DlpInfo>(running ? '/dlp/start' : '/dlp/stop');
  return data;
}
