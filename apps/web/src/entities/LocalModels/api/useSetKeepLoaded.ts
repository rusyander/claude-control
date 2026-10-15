import { useLocalAction } from './useLocalAction';
import type { LocalIdleMinutes, LocalServerInfo } from '@agentdeck/contracts/local-models';
import { put } from '../lib/put';

/** Что прислать: держать ли модель и, если нет, через сколько минут простоя выгружать. */
export interface KeepLoadedBody {
  keepLoaded: boolean;
  idleMinutes?: LocalIdleMinutes;
}

/**
 * «Держать загруженной» и срок выгрузки: оба — аргумент запуска, идущий сервер
 * перезапускается сразу, если срок у него другой.
 */
export const useSetKeepLoaded = () =>
  useLocalAction<KeepLoadedBody, LocalServerInfo>((body) => put('/local-models/keep-loaded', body));
