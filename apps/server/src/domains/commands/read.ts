import type { ClaudePaths, CommandsResponse } from '@claude-control/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { readClaudeCommands } from './claude.ts';
import { readProviderCommands } from './providers.ts';

/** Список команд АКТИВНОГО провайдера: у Claude свои источники, у прочих свои. */
export function readCommands(paths: ClaudePaths, store: AppStore): CommandsResponse {
  const provider = getActiveProvider(store);

  if (provider.id === 'claude') {
    return { provider: provider.id, ...readClaudeCommands(paths, store) };
  }
  return { provider: provider.id, ...readProviderCommands(provider) };
}
