/** Types for the server tests that run the drift check of the kit and the personal layer. */
export interface TwinRoot {
  id: string;
  kit: string;
  global: string;
  pattern: string;
  strict: boolean;
  rename?: Record<string, string>;
  globalPrivate?: { pattern: string; why: string };
  [extra: string]: unknown;
}
export interface TwinPair {
  same: boolean;
  kit: string;
  global: string;
}
export interface TwinLedger {
  roots: TwinRoot[];
  pairs: Record<string, TwinPair>;
  kitOnly: Record<string, string>;
  globalOnly: Record<string, string>;
  wiring?: { module: string; tools: string[]; apply?: string }[];
  [extra: string]: unknown;
}
export interface TwinFinding {
  key: string;
  text: string;
}
export const KIT_ASSETS: string;
export const LEDGER: string;
export function fingerprint(text: string): string;
export function globalDirOf(argv?: string[], env?: NodeJS.ProcessEnv): string | null;
export function checkTwins(options: {
  kitAssets?: string;
  globalDir?: string | null;
  ledger: TwinLedger;
}): { problems: TwinFinding[]; warnings: TwinFinding[] };
export function recordTwins(options: {
  kitAssets?: string;
  globalDir: string | null;
  ledger: TwinLedger;
  accept?: string | null;
  init?: boolean;
}): TwinLedger;
