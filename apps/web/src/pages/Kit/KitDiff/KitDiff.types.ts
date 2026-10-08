import type { DiffLine } from '@agentdeck/contracts';

export interface KitDiffProps {
  /** `null` — текст слишком велик для построчной разницы. */
  lines: DiffLine[] | null;
}
