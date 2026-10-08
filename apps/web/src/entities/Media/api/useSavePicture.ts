import type { MediaImage } from '@agentdeck/contracts';
import { apiClient } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

/** Рисунок, который агент отдал блоком: панель его проверит и положит файлом. */
export async function savePicture(request: {
  chatId: string;
  prompt: string;
  block: string;
  model: string;
}): Promise<MediaImage> {
  const { data } = await apiClient.post<MediaImage>('/media/images/block', request);
  return data;
}

export function useSavePicture() {
  return useMutation({ mutationFn: savePicture });
}
