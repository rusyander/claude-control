import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

export interface SandboxSelection {
  ruleIds?: string[];
  skillIds?: string[];
  hookIds?: string[];
  mcpIds?: string[];
  scriptNames?: string[];
  draftRule?: { title: string; text: string };
}

export interface SandboxDescription {
  rules: string[];
  skills: string[];
  hooks: string[];
  mcpServers: string[];
  scripts: string[];
}

/**
 * Откуда песочница взяла доступ к аккаунту (сервер, `lib/credentials/credentials.ts`).
 * `none` — не взяла ниоткуда: разговор в песочнице не пойдёт.
 */
export type SandboxCredentialsSource = 'file' | 'keychain' | 'panel' | 'apiKey' | 'none';

/** Источник доступа и причина отказа. Ни токена, ни ключа здесь нет. */
export interface SandboxCredentials {
  source: SandboxCredentialsSource;
  reason?: string;
}

export function useCreateSandbox() {
  return useMutation({
    // Сбой создания окно песочницы называет само, рядом с «Повторить».
    meta: { silentError: true },
    mutationFn: async (input: { id: string; selection: SandboxSelection }) => {
      const { data } = await apiClient.post<{
        id: string;
        configDir: string;
        workDir: string;
        description: SandboxDescription;
        // Откуда доступ к аккаунту и почему его нет: без него разговор
        // в песочнице не пойдёт, и сказать об этом надо до первого запроса.
        credentials?: SandboxCredentials;
      }>('/sandbox/create', input, { timeout: 60_000 });
      return data;
    },
  });
}
