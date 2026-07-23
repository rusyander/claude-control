import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HistoryDiff,
  HistoryResponse,
  HistoryRevertHunkRequest,
  HistoryRevertResult,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Лента изменений конфигурации и дифф отдельной копии. Читающие запросы без
 * побочных эффектов: сервер собирает ленту из резервных копий. Полный дифф
 * грузится лениво — только когда запись в ленте раскрыта.
 */

async function fetchHistory(): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>('/history');
  return data;
}

export function useHistory() {
  return useQuery({ queryKey: queryKeys.history, queryFn: fetchHistory });
}

async function fetchDiff(name: string): Promise<HistoryDiff> {
  const { data } = await apiClient.get<HistoryDiff>('/history/diff', { params: { name } });
  return data;
}

/** Дифф конкретной копии. Запрос уходит только при заданном имени (раскрытая запись). */
export function useHistoryDiff(name: string | undefined) {
  return useQuery({
    queryKey: queryKeys.historyDiff(name ?? ''),
    queryFn: () => fetchDiff(name!),
    enabled: Boolean(name),
  });
}

async function revertHunk(body: HistoryRevertHunkRequest): Promise<HistoryRevertResult> {
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
