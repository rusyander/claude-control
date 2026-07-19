import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

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

export interface EventFixture {
  id: string;
  event: string;
  title: string;
  description: string;
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

export type HookDecision = 'block' | 'ask' | 'pass';

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

export function useDeleteSandbox() {
  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/sandbox/${encodeURIComponent(id)}`);
    },
  });
}
