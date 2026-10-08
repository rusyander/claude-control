import { useIsMutating } from '@tanstack/react-query';
import { PLATFORM_SAVE_KEY } from './PlatformApi.constants';

/** Идёт ли сохранение контура: собранный посреди чужой записи, он вернул бы её назад. */
export function useIsPlatformSaving(): boolean {
  return useIsMutating({ mutationKey: PLATFORM_SAVE_KEY }) > 0;
}
