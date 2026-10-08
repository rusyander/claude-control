import { useLocalAction } from './useLocalAction';
import type { LocalConnectInfo } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useConnectLocal = () =>
  useLocalAction<string, LocalConnectInfo>((tag) => post('/local-models/connect', { tag }));
