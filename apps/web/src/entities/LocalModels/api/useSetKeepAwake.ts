import { useLocalAction } from './useLocalAction';
import type { LocalServerInfo } from '@agentdeck/contracts/local-models';
import { put } from '../lib/put';

/** «Не давать системе уснуть во время прогона»: перезапуска не требует, панель сама ставит и снимает запрет. */
export const useSetKeepAwake = () =>
  useLocalAction<boolean, LocalServerInfo>((keepAwake) =>
    put('/local-models/keep-awake', { keepAwake }),
  );
