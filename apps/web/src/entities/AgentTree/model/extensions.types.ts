import type { AgentExtensionKind } from '@agentdeck/contracts';

/** Итоги агента по видам и отказы хуков. */
export type ExtensionTotals = Record<AgentExtensionKind, number> & {
  denied: number;
  errors: number;
};

/** Значок строки агента. */
export interface ExtensionChip {
  /** `denied` — отказы хуков отдельным значком. */
  kind: AgentExtensionKind | 'denied';
  /** Имя скилла или сервера MCP; у хуков и отказов — пусто, значок говорит числом. */
  label: string;
  count: number;
  /** «ещё N» — имён больше, чем значков. */
  more?: boolean;
}
