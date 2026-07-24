import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppSettings,
  ClaudeLocation,
  InstructionsFileInfo,
  Overview,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';

// Транспорт: чистые функции, ничего не знающие про React.

async function getLocation(): Promise<ClaudeLocation> {
  const { data } = await apiClient.get<ClaudeLocation>('/location');
  return data;
}

async function setLocation(path: string): Promise<ClaudeLocation> {
  const { data } = await apiClient.post<ClaudeLocation>('/location', { path });
  return data;
}

async function getSettings(): Promise<AppSettings> {
  const { data } = await apiClient.get<AppSettings>('/settings');
  return data;
}

async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const { data } = await apiClient.patch<AppSettings>('/settings', patch);
  return data;
}

async function getOverview(): Promise<Overview> {
  const { data } = await apiClient.get<Overview>('/overview');
  return data;
}

async function getClaudeMd(): Promise<InstructionsFileInfo> {
  // Раздел универсален по активному провайдеру: сервер отдаёт содержимое файла
  // инструкций (CLAUDE.md/AGENTS.md/GEMINI.md) вместе с метаданными — имя файла,
  // путь, обнаружен ли CLI и данные провайдера, — по которым адаптируется страница.
  const { data } = await apiClient.get<InstructionsFileInfo>('/claude-md');
  return data;
}

async function putClaudeMd(content: string): Promise<void> {
  await apiClient.put('/claude-md', { content });
}

// Хуки: компоненты работают только с ними.

export function useLocation() {
  return useQuery({ queryKey: queryKeys.location, queryFn: getLocation });
}

export function useSettings() {
  return useQuery({ queryKey: queryKeys.settings, queryFn: getSettings });
}

export function useOverview() {
  return useQuery({ queryKey: queryKeys.overview, queryFn: getOverview });
}

export function useClaudeMd() {
  return useQuery({ queryKey: queryKeys.claudeMd, queryFn: getClaudeMd });
}

export function useUpdateClaudeMd() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: putClaudeMd,
    onSuccess: () => {
      // Правки CLAUDE.md меняют и разбор правил, и обзор.
      void queryClient.invalidateQueries({ queryKey: queryKeys.claudeMd });
      void queryClient.invalidateQueries({ queryKey: queryKeys.rules });
      void queryClient.invalidateQueries({ queryKey: queryKeys.overview });
    },
    meta: { successMessage: 'claudeMd.saved' },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchSettings,
    onSuccess: (settings, variables) => {
      // Настройки кладём в кеш напрямую: тема и язык должны примениться
      // мгновенно, без ожидания повторного запроса.
      queryClient.setQueryData(queryKeys.settings, settings);
      // Смена провайдера меняет активный id и карту возможностей — перечитываем
      // /providers, чтобы навигация перестроилась под нового провайдера.
      if (variables.provider !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
      }
    },
  });
}

export function useSetLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: setLocation,
    onSuccess: () => {
      // Смена каталога меняет вообще всё, что показывает приложение.
      void queryClient.invalidateQueries();
    },
    meta: { successMessage: 'toasts.locationChanged' },
  });
}
