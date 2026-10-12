export type GuardRuleId =
  | 'prod-target'
  | 'sql-drop'
  | 'sql-truncate'
  | 'sql-unbounded'
  | 'migration-down'
  | 'infra-change'
  | 'volume-delete';

export interface GuardConfig {
  version?: number;
  lang?: string;
  prodMarkers?: string[];
  disabled?: string[];
}

export interface GuardHit {
  rule: GuardRuleId;
  match: string;
}

export const GUARD_VERSION: number;
export const GUARD_RULE_IDS: readonly GuardRuleId[];
export function prodMarkersOf(config: GuardConfig | undefined): string[];
export function classify(
  text: string,
  config?: GuardConfig,
  kind?: 'bash' | 'mcp',
): GuardHit | undefined;
export function mcpText(input: unknown): string;
export function classifyCall(
  toolName: string,
  input: unknown,
  config?: GuardConfig,
): GuardHit | undefined;
export function reasonText(hit: GuardHit, lang?: string): string;
