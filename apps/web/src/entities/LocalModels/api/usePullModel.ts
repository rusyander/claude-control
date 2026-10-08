import { useLocalAction } from './useLocalAction';
import type { LocalJob } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

/** Скачать модель; `connect` — по готовности сразу включить её агентам. */
export const usePullModel = () =>
  useLocalAction<{ tag: string; connect?: boolean }, LocalJob>((input) =>
    post('/local-models/pull', input),
  );
