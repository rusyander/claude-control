import type { ProjectTestImportResult } from '@agentdeck/contracts';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { testKeys } from './keys';

export function useImportMutation<TPayload>(
  send: (payload: TPayload) => Promise<ProjectTestImportResult>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => void client.invalidateQueries({ queryKey: testKeys.root }),
  });
}
