import type { LocalLayerFit } from '@agentdeck/contracts/local-models';

export interface LocalLayerNoticeProps {
  /** Последний замер слоя против окна сервера; влезает или нет замера — строки нет. */
  layer: LocalLayerFit | undefined;
  /** Разговор, в котором стоит строка: замороженные описания MCP — только про него. */
  session?: string;
  className?: string;
}

export interface LocalLayerWarningProps {
  session?: string;
  className?: string;
}
