import { useMutation } from '@tanstack/react-query';
import type { PanelPendingDecision } from '@agentdeck/contracts/panel-agent';
import { decidePanelAction } from './decidePanelAction';

export function useDecidePanelAction() {
  return useMutation({
    mutationFn: ({ id, decision }: { id: string } & PanelPendingDecision) =>
      decidePanelAction(id, decision),
  });
}
