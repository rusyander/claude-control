import { useLocalAction } from './useLocalAction';
import type { LocalConnectInfo } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useDisconnectLocal = () =>
  useLocalAction<void, LocalConnectInfo>(() => post('/local-models/disconnect'));
