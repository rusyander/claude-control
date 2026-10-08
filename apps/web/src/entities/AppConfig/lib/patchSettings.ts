import type { AppSettings } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const { data } = await apiClient.patch<AppSettings>('/settings', patch);
  return data;
}
