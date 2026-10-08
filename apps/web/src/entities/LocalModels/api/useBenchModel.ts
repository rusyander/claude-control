import { useLocalAction } from './useLocalAction';
import type { ModelBench } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useBenchModel = () =>
  useLocalAction<string, ModelBench>((tag) => post('/local-models/bench', { tag }));
