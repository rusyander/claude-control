import { useLocalAction } from './useLocalAction';
import type { LocalJob } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useInstallQwenCode = () =>
  useLocalAction<void, LocalJob>(() => post('/local-models/qwen-code/install'));
