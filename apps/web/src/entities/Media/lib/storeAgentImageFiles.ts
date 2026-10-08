import type { AgentImage } from '@agentdeck/contracts/agent-images';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';

/**
 * Картинки для чужого CLI: панель кладёт их файлами в свой каталог данных и
 * отдаёт пути — дальше они едут вложениями, как файл, выбранный в проводнике
 * панели (CLI читает их сам). Проверка та же, что у картинок в запросе.
 */
export async function storeAgentImageFiles(
  images: AgentImage[],
): Promise<{ name: string; path: string }[]> {
  const { data } = await apiClient.post<{ files: { name: string; path: string }[] }>(
    '/media/agent-files',
    { images },
    { timeout: LONG_TIMEOUTS.assistantRun },
  );
  return data.files;
}
