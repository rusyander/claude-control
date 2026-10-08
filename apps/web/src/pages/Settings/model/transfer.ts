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
  link.download = 'agentdeck-settings.json';
  link.click();
  URL.revokeObjectURL(url);
}
