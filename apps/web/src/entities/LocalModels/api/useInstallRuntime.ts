import { useLocalAction } from './useLocalAction';
import type { LocalJob } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useInstallRuntime = () =>
  useLocalAction<void, LocalJob>(() => post('/local-models/runtime/install'));
