import { useLocalAction } from './useLocalAction';
import type { LocalServerInfo } from '@agentdeck/contracts/local-models';
import { put } from '../lib/put';

/** «Держать загруженной»: идущий сервер перезапускается с новым флагом простоя сразу. */
export const useSetKeepLoaded = () =>
  useLocalAction<boolean, LocalServerInfo>((keepLoaded) =>
    put('/local-models/keep-loaded', { keepLoaded }),
  );
