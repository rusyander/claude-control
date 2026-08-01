import type { ReactNode } from 'react';
import type { Capability } from '@claude-control/contracts';

export interface RouteGateProps {
  capability: Capability;
  children: ReactNode;
}
