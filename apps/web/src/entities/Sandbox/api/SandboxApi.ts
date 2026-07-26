import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { sandboxDeleteFailedText } from '../model/sandboxError';

/**
 * Проверка настроек в изоляции. Сервер собирает временную конфигурацию
 * Claude Code, куда попадает только проверяемое, поэтому прогон ничего
 * не задевает в настоящих настройках.
 */

export type SandboxKind = 'rule' | 'skill' | 'hook' | 'script' | 'mcp' | 'group';

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
 * Откуда песочница взяла доступ к аккаунту (сервер, `lib/credentials.ts`).
 * `none` — не взяла ниоткуда: разговор в песочнице не пойдёт.
 */
export type SandboxCredentialsSource = 'file' | 'keychain' | 'panel' | 'apiKey' | 'none';

/** Источник доступа и причина отказа. Ни токена, ни ключа здесь нет. */
export interface SandboxCredentials {
  source: SandboxCredentialsSource;
  reason?: string;
}

export interface EventFixture {
  id: string;
  event: string;
  title: string;
  description: string;
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

/** `error` — прогон не состоялся: хук не запустился или упал, решения нет. */
export type HookDecision = 'block' | 'ask' | 'pass' | 'error';

export interface ProbeResult {
  fixtureId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: HookDecision;
  reason?: string;
  addedContext?: string;
  matchesExpectation: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export function useEventFixtures() {
  return useQuery({
    queryKey: ['sandbox', 'fixtures'],
    queryFn: async () => {
      const { data } = await apiClient.get<EventFixture[]>('/sandbox/fixtures');
      return data;
    },
    staleTime: Infinity,
  });
}

export function useCreateSandbox() {
  return useMutation({
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

export function useProbeHook() {
  return useMutation({
    mutationFn: async (input: {
      id: string;
      hookId?: string;
      scriptName?: string;
      fixtureIds?: string[];
      /** Свой ввод: сырой JSON события вместо заготовок. */
      customEvent?: string;
    }) => {
      const { data } = await apiClient.post<{
        results: ProbeResult[];
        command?: string;
        error?: string;
      }>('/sandbox/probe-hook', input, { timeout: 180_000 });
      return data;
    },
  });
}

export function useMcpTools() {
  return useMutation({
    mutationFn: async (mcpId: string) => {
      const { data } = await apiClient.post<{ tools: McpTool[]; error?: string }>(
        '/sandbox/mcp-tools',
        { mcpId },
        { timeout: 120_000 },
      );
      return data;
    },
  });
}

export function useCallMcpTool() {
  return useMutation({
    mutationFn: async (input: { mcpId: string; tool: string; args: Record<string, unknown> }) => {
      const { data } = await apiClient.post<{
        ok: boolean;
        content: string;
        isError: boolean;
        durationMs: number;
      }>('/sandbox/mcp-call', input, { timeout: 120_000 });
      return data;
    },
  });
}

/**
 * Удаление песочницы. Уходит из размонтирования модалки, то есть с экрана, до
 * которого ответ уже не вернётся, — поэтому отказ показывается тостом.
 *
 * `silentError` выключает общий тост из MutationCache: он показал бы сырое
 * сообщение сервера без объяснения, чем это грозит. Здесь текст свой, с рамкой
 * и на языке интерфейса, а причина сервера (в ней путь к папке) внутри.
 */
export function useDeleteSandbox() {
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/sandbox/${encodeURIComponent(id)}`);
    },
    meta: { silentError: true },
    onError: (error) => toast.error(sandboxDeleteFailedText(error, t)),
  });
}
