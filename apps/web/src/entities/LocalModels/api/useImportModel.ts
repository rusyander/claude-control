import { useLocalAction } from './useLocalAction';
import type { LocalJob } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

export const useImportModel = () =>
  useLocalAction<string, LocalJob>((tag) => post('/local-models/import', { tag }));
