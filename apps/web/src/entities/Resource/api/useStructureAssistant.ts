import type { ResourceKind } from './ResourceApi.types';
import { useResourceMutation } from './useResourceMutation';
import type { AgentImage } from '@agentdeck/contracts/agent-images';
import { apiClient } from '@shared/api/client';

export interface StructureAssistReply {
  reply: string;
  applied: string[];
  /** Файлы с секретом, который помощник видел маской и не вернул на место: не записаны. */
  kept?: string[];
}

/**
 * Помощник структуры: по описанию задачи собирает или дополняет файлы ресурса
 * целиком и сразу их применяет. В отличие от помощника форм заполняет не поля,
 * а дерево.
 */
export function useStructureAssistant(kind: ResourceKind, id: string) {
  return useResourceMutation(
    kind,
    id,
    async (input: {
      prompt: string;
      /** Прежние реплики окна: сессии у помощника нет. */
      history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      images?: AgentImage[];
    }): Promise<StructureAssistReply> => {
      const { data } = await apiClient.post<StructureAssistReply>(
        `/resources/${kind}/${encodeURIComponent(id)}/assist`,
        input,
        { timeout: 260_000 },
      );
      return data;
    },
    undefined,
    // Отказ (картинок больше восьми, не тот тип) помощник называет сам.
    true,
  );
}
