import type { QueryClient } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Перенос настроек панели: снимок state.json скачивается файлом и вливается
 * обратно на другой машине — раньше это делали только копированием руками.
 */
export async function exportPanelState(): Promise<void> {
  const { data } = await apiClient.get('/settings/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'claude-control-settings.json';
  link.click();
  URL.revokeObjectURL(url);
}

/** Снимок с диска → сервер; после импорта устаревает всё, что показывает панель. */
export async function importPanelState(file: File, queryClient: QueryClient): Promise<void> {
  const parsed: unknown = JSON.parse(await file.text());
  await apiClient.post('/settings/import', parsed);
  await queryClient.invalidateQueries();
}
