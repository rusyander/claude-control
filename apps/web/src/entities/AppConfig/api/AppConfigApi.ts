import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type {
  AppSettings,
  ClaudeLocation,
  InstructionsFileInfo,
  Overview,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { isProviderScopedKey, queryKeys } from '@shared/api/query-keys';

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

/**
 * Файл инструкций активного провайдера. `enabled: false` — не запрашивать:
 * у провайдера без глобальных инструкций (Continue) сервер отвечает 400, и
 * страница, которой файл нужен лишь для подсказки, не должна его дёргать.
 */
export function useClaudeMd(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.claudeMd,
    queryFn: getClaudeMd,
    enabled: options.enabled ?? true,
  });
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

/**
 * Разложить ответ `PATCH /settings` по кешу.
 *
 * Вынесено из хука отдельной функцией, потому что прогон фронта идёт в node без
 * DOM: отрендерить мутацию в тесте негде, а поведение при смене провайдера
 * проверять обязательно.
 */
export function applySettingsUpdate(
  queryClient: QueryClient,
  settings: AppSettings,
  patch: Partial<AppSettings>,
): void {
  // Настройки кладём в кеш напрямую: тема и язык должны примениться
  // мгновенно, без ожидания повторного запроса.
  queryClient.setQueryData(queryKeys.settings, settings);
  if (patch.provider === undefined) return;
  // Смена провайдера меняет активный id и карту возможностей — перечитываем
  // /providers, чтобы навигация перестроилась под нового провайдера.
  void queryClient.invalidateQueries({ queryKey: queryKeys.providers });
  // Разделы универсального слоя кешированы без id провайдера. Именно reset, а
  // не invalidate: invalidate оставляет данные в кеше, и раздел успевает
  // отрисовать файлы ПРОШЛОГО CLI и утащить их в локальный state редактора —
  // а «Сохранить» уже уйдёт на маршрут нового провайдера. Сброс гарантирует
  // загрузку вместо чужих данных; открытые разделы перезапросятся сразу.
  void queryClient.resetQueries({ predicate: (query) => isProviderScopedKey(query.queryKey) });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: patchSettings,
    onSuccess: (settings, variables) => {
      applySettingsUpdate(queryClient, settings, variables);
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
    // Тост об успехе — у вызывающего: сервер отвечает 200 и на отказанный путь
    // (`isValid: false` с причиной), а общий `successMessage` хвалил и его.
  });
}
