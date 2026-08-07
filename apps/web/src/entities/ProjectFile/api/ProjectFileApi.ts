import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectCodeLayout,
  ProjectCodeView,
  ProjectFileChanges,
  ProjectFileContent,
  ProjectFileSaveResult,
  ProjectFileTree,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';

/**
 * Файлы проекта, открытого в чате.
 *
 * Дерево грузится по уровню (запрос на каждый раскрытый каталог), сводка правок
 * агента — один раз на разговор, содержимое — на открытый файл. Разделение
 * именно такое, потому что перечитывать надо разное: дерево меняется от
 * раскрытия ветки, сводка — от хода агента, файл — от собственной записи.
 */

const ROOT_KEY = 'project-files';

export function useProjectTree(path: string | undefined, dir: string) {
  return useQuery({
    queryKey: [ROOT_KEY, 'tree', path ?? '', dir],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileTree>('/project-files/tree', {
        params: { path, dir },
      });
      return data;
    },
    enabled: Boolean(path),
  });
}

/**
 * Что агент поменял в этом разговоре. Пока прогон идёт, ответ устаревает с
 * каждым ходом, поэтому свежесть здесь нулевая: список отметок в дереве обязан
 * догонять работу агента, а не показывать снимок на момент открытия окна.
 */
export function useProjectChanges(path: string | undefined, chatId: string | undefined) {
  return useQuery({
    queryKey: [ROOT_KEY, 'changes', path ?? '', chatId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileChanges>('/project-files/changes', {
        params: { path, chatId },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: 0,
  });
}

export function useProjectFile(
  path: string | undefined,
  file: string | undefined,
  chatId: string | undefined,
) {
  return useQuery({
    queryKey: [ROOT_KEY, 'content', path ?? '', file ?? '', chatId ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectFileContent>('/project-files/content', {
        params: { path, file, chatId },
      });
      return data;
    },
    enabled: Boolean(path && file),
    staleTime: 0,
  });
}

/**
 * Запись правки человека.
 *
 * Ответ сервера кладём в кэш файла сразу: в нём новое время записи, и без него
 * следующее сохранение ушло бы со старым `mtimeMs` — то есть отбилось бы как
 * несвежее сразу после успешной записи. Сводку правок при этом сбрасываем:
 * ручная правка меняет и дифф.
 */
export function useSaveProjectFile(path: string | undefined, chatId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { file: string; content: string; mtimeMs: number }) => {
      const { data } = await apiClient.put<ProjectFileSaveResult>('/project-files/content', {
        path,
        ...input,
      });
      return { ...data, file: input.file, content: input.content };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<ProjectFileContent>(
        [ROOT_KEY, 'content', path ?? '', result.file, chatId ?? ''],
        (current) =>
          current
            ? {
                ...current,
                content: result.content,
                mtimeMs: result.mtimeMs,
                sizeBytes: result.sizeBytes,
              }
            : current,
      );
      void queryClient.invalidateQueries({ queryKey: [ROOT_KEY, 'changes'] });
    },
    meta: { successMessage: 'toasts.saved' },
  });
}

/**
 * Адрес файла для показа тегом: картинку и PDF браузер тянет сам.
 *
 * `mtimeMs` в адресе — не украшение: ответ отдаётся без кэша, но у самого тега
 * `img` кэш свой, и без смены адреса перезаписанная агентом картинка осталась
 * бы на экране прежней.
 */
export function projectFileRawUrl(path: string, file: string, mtimeMs: number): string {
  const query = new URLSearchParams({ path, file, v: String(Math.round(mtimeMs)) });
  return `${apiClient.defaults.baseURL}/project-files/raw?${query.toString()}`;
}

/**
 * Что было открыто в окне кода этого проекта.
 *
 * Снимок хранится на сервере, в состоянии панели: у каждого таба своё дерево и
 * свой файл, и терять их при чистке кэша браузера незачем. Перезапрашивать
 * нечего — записываем сюда только мы сами, поэтому свежесть бесконечная.
 */
export function useProjectCodeView(path: string | undefined) {
  return useQuery({
    queryKey: [ROOT_KEY, 'view', path ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectCodeView | null>('/project-files/view', {
        params: { path },
      });
      return data;
    },
    enabled: Boolean(path),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Повтор здесь только тормозит открытие: эндпоинт локальный, а отказ по
    // нему означает «снимка не будет», а не «попробуй ещё раз». Окно ждёт
    // ответа, чтобы не затереть сохранённое, — и ждать лишний круг незачем.
    retry: false,
  });
}

/**
 * Запомнить снимок. Кэш запроса обновляем сами, а не перечитыванием: ответ
 * сервера ничего нового не несёт, а лишний круг сети на каждое раскрытие папки
 * — плата ни за что.
 */
export function useSaveProjectCodeView(path: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (view: ProjectCodeView) => {
      await apiClient.put('/project-files/view', { path, view });
      return view;
    },
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectCodeView | null>([ROOT_KEY, 'view', path ?? ''], view);
    },
    // Молча: это фоновая память об открытом, а не действие человека. Тост на
    // каждое раскрытие папки, когда сервер недоступен, был бы шумом о том, чего
    // никто не просил.
    meta: { silentError: true },
  });
}

/**
 * Раскладка окна — одна на панель, поэтому и ключ запроса без пути проекта.
 * Ширина списка файлов настраивается один раз и ожидается в любом проекте.
 */
export function useProjectCodeLayout(isEnabled: boolean) {
  return useQuery({
    queryKey: [ROOT_KEY, 'layout'],
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectCodeLayout>('/project-files/layout');
      return data;
    },
    enabled: isEnabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Ширину пишем по концу перетаскивания; ответ сервера уже обрезан по границам. */
export function useSaveProjectCodeLayout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (layout: ProjectCodeLayout) => {
      const { data } = await apiClient.put<ProjectCodeLayout>('/project-files/layout', layout);
      return data;
    },
    onSuccess: (layout) => {
      queryClient.setQueryData<ProjectCodeLayout>([ROOT_KEY, 'layout'], layout);
    },
    meta: { silentError: true },
  });
}

/** Таб закрыли — снимок стирается: следующее открытие начнётся с чистого листа. */
export function useForgetProjectCodeView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { path: string }) => {
      await apiClient.delete('/project-files/view', { params: { path: input.path } });
      return input;
    },
    onSuccess: (input) => {
      queryClient.removeQueries({ queryKey: [ROOT_KEY, 'view', input.path] });
    },
    // Вкладку закрывают, а не «забывают снимок»: отказ сервера здесь — не то, о
    // чём стоит сообщать поверх уже закрытой вкладки.
    meta: { silentError: true },
  });
}
