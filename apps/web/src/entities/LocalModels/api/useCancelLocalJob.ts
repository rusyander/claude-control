import { useLocalAction } from './useLocalAction';
import { apiClient } from '@shared/api/client';

export const useCancelLocalJob = () =>
  useLocalAction<string, void>(async (id) => {
    await apiClient.post(`/local-models/jobs/${encodeURIComponent(id)}/cancel`);
  });
