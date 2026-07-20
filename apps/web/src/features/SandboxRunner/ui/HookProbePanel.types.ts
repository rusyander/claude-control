import type { ProbeResult } from '@entities/Sandbox';

export interface HookProbePanelProps {
  sandboxId: string;
  hookId?: string;
  scriptName?: string;
}

export interface ResultRowProps {
  result: ProbeResult;
  title: string;
}
