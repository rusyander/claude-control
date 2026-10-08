import type { PlatformToolShimReport } from '@agentdeck/contracts';

export interface ToolShimCardProps {
  /** Сводки может не быть и она может прийти неполной — карточка это переживает. */
  report: PlatformToolShimReport | undefined;
}
