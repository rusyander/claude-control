import { useQuery } from '@tanstack/react-query';
import type { MediaImage, MediaImagePlan } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export {
  formatBytes,
  imageCardLines,
  imageModeView,
  mediaChatId,
  mediaImagePath,
  planImageSubmit,
  type ImageAction,
  type ImageModeView,
} from './mode';

/**
 * Рисование — минуты, а обычный потолок запроса телефона 20 с: он оборвал бы
 * удачный запрос и списал бы деньги ключа впустую. Тот же потолок, что у панели.
 */
const IMAGE_TIMEOUT_MS = 190_000;

/**
 * Чем нарисуем. `agent=1` всегда: экран чата телефона — это разговор, и агент в
 * нём есть даже у черновика (первое сообщение и начинает прогон). Решение по
 * дороге принимает сервер.
 */
export function useImagePlan() {
  return useQuery({
    queryKey: ['media-image-plan', 'agent'],
    queryFn: () => api.get<MediaImagePlan>('/media/images/plan', { agent: 1 }),
    staleTime: 30_000,
    retry: false,
  });
}

/** Панель рисует сама: результат — запись и файл у неё, не реплика в переписке. */
export function createImage(request: { chatId: string; prompt: string }): Promise<MediaImage> {
  return api.post<MediaImage>('/media/images', request, { timeoutMs: IMAGE_TIMEOUT_MS });
}

/**
 * Готовая просьба агенту. Собирает сервер: правила живут в каталоге промптов, и
 * вторая сборка на телефоне разошлась бы с ними после первой правки.
 */
export async function pictureRequest(topic: string): Promise<string> {
  const { prompt } = await api.post<{ prompt: string }>('/media/prompt', {
    kind: 'picture',
    topic,
  });
  return prompt;
}
