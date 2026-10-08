import { useLocalAction } from './useLocalAction';
import type { LocalDevice, LocalServerInfo } from '@agentdeck/contracts/local-models';
import { put } from '../lib/put';

/** Где считать: идущий сервер перезапускается с новым устройством сразу. */
export const useSetLocalDevice = () =>
  useLocalAction<LocalDevice, LocalServerInfo>((device) => put('/local-models/device', { device }));
