import { useLocalAction } from './useLocalAction';
import type { LocalClaudeInfo } from '@agentdeck/contracts/local-models';
import { put } from '../lib/put';

/** «Claude Code на локальной модели»: settings.json Claude, выключение возвращает прежнее. */
export const useSetLocalClaude = () =>
  useLocalAction<{ on: boolean; tag?: string }, LocalClaudeInfo>((body) =>
    put('/local-models/claude', body),
  );
