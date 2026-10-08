import type { FormatCheckReport } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function refreshFormatCheck(): Promise<FormatCheckReport> {
  const { data } = await apiClient.post<FormatCheckReport>('/format-check/refresh');
  return data;
}
