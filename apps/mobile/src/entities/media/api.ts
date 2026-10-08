import { useQuery } from '@tanstack/react-query';
import type { MediaImagePlan } from '@agentdeck/contracts';
import { api } from '../../shared/api/client';

export { imageModeView, type ImageModeView } from './mode';
export { imageCardLines } from './imageCardLines';
export { planImageSubmit } from './planImageSubmit';
export type { ImageAction } from './planImageSubmit';
export { formatBytes } from './formatBytes';
export { mediaImagePath } from './mediaImagePath';
export { mediaChatId } from './mediaChatId';

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
