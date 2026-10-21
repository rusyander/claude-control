import type { AppSettings, AppSettingsPatch } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function patchSettings(patch: AppSettingsPatch): Promise<AppSettings> {
  const { data } = await apiClient.patch<AppSettings>('/settings', patch);
  return data;
}
