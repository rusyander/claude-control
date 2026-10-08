import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface EditorInfo {
  id: string;
  name: string;
  command: string;
  available: boolean;
}

/** Редакторы, установленные в системе, — для выбора в настройках. */
export function useEditors() {
  return useQuery({
    queryKey: ['editors'],
    queryFn: async () => {
      const { data } = await apiClient.get<EditorInfo[]>('/editors');
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}
