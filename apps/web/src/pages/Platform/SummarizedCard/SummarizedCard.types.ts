import type { PlatformSummarizedReport } from '@agentdeck/contracts';

export interface SummarizedCardProps {
  report: PlatformSummarizedReport | undefined;
  /** Id контура → его название: в строке человек читает имя, а не id. */
  platformTitles: Record<string, string>;
}
