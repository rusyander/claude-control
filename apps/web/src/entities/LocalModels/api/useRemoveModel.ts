import { useLocalAction } from './useLocalAction';
import { apiClient } from '@shared/api/client';

export const useRemoveModel = () =>
  useLocalAction<string, void>(async (tag) => {
    await apiClient.delete(`/local-models/models/${encodeURIComponent(tag)}`);
  });
