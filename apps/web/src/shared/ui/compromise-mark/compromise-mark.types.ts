import type { CompromiseId } from '@agentdeck/contracts';

export interface CompromiseMarkProps {
  /** Идентификатор из реестра подписей. Тексты берутся из словаря по нему же. */
  id: CompromiseId;
  className?: string;
}
