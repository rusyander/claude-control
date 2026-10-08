import type { HistoryRevertHunkRequest, HistoryRevertResult } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useQueryClient, useMutation } from '@tanstack/react-query';

export async function revertHunk(body: HistoryRevertHunkRequest): Promise<HistoryRevertResult> {
  const { data } = await apiClient.post<HistoryRevertResult>('/history/revert-hunk', body);
  return data;
}

/**
 * Выборочный откат ОДНОГО ханка из копии в текущий файл. После успеха обновляем
 * всё: правка меняет рабочий конфиг, а сам откат добавляет новую копию в ленту.
 */
export function useRevertHunk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: revertHunk,
    onSuccess: () => void queryClient.invalidateQueries(),
    meta: { successMessage: 'toasts.restored' },
  });
}
