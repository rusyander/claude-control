import type { ClaudeLocation } from '@agentdeck/contracts';

export interface LocationCardProps {
  location: ClaudeLocation;
  /** Выбранный провайдер — Claude Code: без его каталога он не работает. */
  claudeInUse: boolean;
}
