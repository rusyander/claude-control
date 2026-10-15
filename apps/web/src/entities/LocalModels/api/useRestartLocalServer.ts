import type { LocalServerInfo } from '@agentdeck/contracts/local-models';
import { useLocalAction } from './useLocalAction';
import { post } from '../lib/post';

/** «Перезапустить» из чата: тот же сервер моделей заново, теми же параметрами (L6). */
export const useRestartLocalServer = () =>
  useLocalAction<void, LocalServerInfo>(() => post('/local-models/server/restart'));
