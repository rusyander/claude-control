import type { MediaImage } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { useMutation } from '@tanstack/react-query';

export async function createImage(request: {
  chatId: string;
  prompt: string;
}): Promise<MediaImage> {
  const { data } = await apiClient.post<MediaImage>('/media/images', request, {
    // Рисование — минуты: обычный потолок ответа здесь оборвал бы удачный запрос
    // и списал бы деньги ключа впустую.
    timeout: LONG_TIMEOUTS.mediaImage,
  });
  return data;
}

export function useCreateImage() {
  return useMutation({ mutationFn: createImage });
}
