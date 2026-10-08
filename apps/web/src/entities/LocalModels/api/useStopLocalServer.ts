import { useLocalAction } from './useLocalAction';
import { post } from '../lib/post';

export const useStopLocalServer = () =>
  useLocalAction<void, { unloaded: string[] }>(() => post('/local-models/server/stop'));
