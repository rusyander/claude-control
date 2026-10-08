import { useScriptMutation } from './useScriptMutation';
import { apiClient } from '@shared/api/client';
import type { ScriptWriteResult } from './ScriptApi.types';
import { encodeScriptId } from '../lib/encodeScriptId';

export function useDeleteScript() {
  return useScriptMutation(async (id: string) => {
    const { data } = await apiClient.delete<ScriptWriteResult>(`/scripts/${encodeScriptId(id)}`);
    return data;
  }, 'toasts.deleted');
}
