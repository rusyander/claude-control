import type { PlatformRulesApplies } from '@agentdeck/contracts';

export interface SideOffNoteProps {
  /** Выбор, которым сторона снята; нет — сторона действует, надписи нет. */
  offBy: PlatformRulesApplies | undefined;
}
