import type { PanelAgentEvent } from '@agentdeck/contracts/panel-agent';

export type Listener = (event: PanelAgentEvent) => void;
