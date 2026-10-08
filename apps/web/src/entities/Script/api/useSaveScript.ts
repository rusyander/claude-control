import { useScriptMutation } from './useScriptMutation';
import { apiClient } from '@shared/api/client';
import type { ScriptWriteResult } from './ScriptApi.types';
import { encodeScriptId } from '../lib/encodeScriptId';

export function useSaveScript() {
  return useScriptMutation(async (input: { id?: string; name: string; content: string }) => {
    // Правка под тем же именем — PUT в тот же файл. Новое имя — и при создании,
    // и при переименовании в редакторе — POST: сервер заводит новый файл, а
    // занятое имя отклоняет (409); старый файл остаётся на месте, как и обещает
    // подсказка под полем имени. Раньше набранное имя при правке молча терялось.
    if (input.id && input.id === input.name) {
      const { data } = await apiClient.put<ScriptWriteResult>(
        `/scripts/${encodeScriptId(input.id)}`,
        { content: input.content },
      );
      return data;
    }
    const { data } = await apiClient.post<ScriptWriteResult>('/scripts', {
      name: input.name,
      content: input.content,
    });
    return data;
  }, 'toasts.saved');
}
