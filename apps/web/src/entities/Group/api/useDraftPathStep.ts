import type { PathStepProposal, PathStepDraftBody } from '@agentdeck/contracts';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface PathStepDraftResult {
  conversationId: string;
  proposal: PathStepProposal;
}

/** Один круг разговора с ассистентом шага; ответ человека на вопросы — следующий круг. */
export function useDraftPathStep(id: string) {
  return useMutation({
    mutationFn: async (request: PathStepDraftBody) => {
      const { data } = await apiClient.post<PathStepDraftResult>(
        `/groups/${id}/path/draft`,
        request,
      );
      return data;
    },
  });
}
