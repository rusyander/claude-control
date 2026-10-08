import type { DlpRule, DlpPreviewResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';

export async function preview(input: {
  text: string;
  rules?: DlpRule[];
}): Promise<DlpPreviewResult> {
  const { data } = await apiClient.post<DlpPreviewResult>('/dlp/preview', input);
  return data;
}
