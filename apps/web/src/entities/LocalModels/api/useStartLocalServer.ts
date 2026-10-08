import { useLocalAction } from './useLocalAction';
import type { LocalServerInfo } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useStartLocalServer = () =>
  useLocalAction<string | undefined, LocalServerInfo>((tag) =>
    post('/local-models/server/start', tag ? { tag } : {}),
  );
