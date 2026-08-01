import type { ReactNode } from 'react';
import type { Capability } from '@agentdeck/contracts';

export interface RouteGateProps {
  capability: Capability;
  children: ReactNode;
}
