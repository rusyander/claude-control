import type { LocalLayerFit } from '@agentdeck/contracts/local-models';

export interface LocalLayerNoticeProps {
  /** Последний замер слоя против окна сервера; влезает или нет замера — строки нет. */
  layer: LocalLayerFit | undefined;
  className?: string;
}

export interface LocalLayerWarningProps {
  className?: string;
}
