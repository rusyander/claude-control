import type { AppSettings } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function getSettings(): Promise<AppSettings> {
  const { data } = await apiClient.get<AppSettings>('/settings');
  return data;
}
