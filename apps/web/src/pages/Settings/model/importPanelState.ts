import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/** Снимок с диска → сервер; после импорта устаревает всё, что показывает панель. */
export async function importPanelState(file: File, queryClient: QueryClient): Promise<void> {
  const parsed: unknown = JSON.parse(await file.text());
  await apiClient.post('/settings/import', parsed);
  await queryClient.invalidateQueries();
}
