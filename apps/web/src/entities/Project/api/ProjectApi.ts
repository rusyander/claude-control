import { useMutation, useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';

/**
 * Проекты, с которыми работал Claude Code. Список выводится на сервере из
 * истории чатов (каталог каждой сессии), поэтому здесь только запрос — вся
 * логика группировки и отсева живёт в домене `ChatProjects`.
 */

/** Ссылка на чат внутри проекта — для списка чатов таба проекта. */
export interface ProjectChatRef {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  /** Счётчик неполный: у большого транскрипта середина не сосчитана (см. chatSummarySchema). */
  messageCountPartial?: boolean;
  isSandbox: boolean;
}

export interface ProjectInfo {
  /** Абсолютный путь каталога проекта. */
  path: string;
  /** Короткое имя для интерфейса. */
  name: string;
  /** Существует ли каталог на диске сейчас. */
  exists: boolean;
  /** Последняя активность по чатам проекта, ISO. */
  lastActivity: string;
  /** Сессии проекта, свежие первыми. */
  chats: ProjectChatRef[];
}

export const projectsKey = ['chats', 'projects'] as const;

export function useProjects() {
  return useQuery({
    queryKey: projectsKey,
    queryFn: async () => {
      const { data } = await apiClient.get<ProjectInfo[]>('/chats/projects');
      return data;
    },
  });
}

// --- Обзор файловой системы для выбора папки проекта ---

export interface DirEntry {
  name: string;
  path: string;
  /** Есть только у файлов — их показывают, лишь когда запрошены расширения. */
  isFile?: boolean;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
}

/** Точки входа обзора: домашняя папка и корни дисков. */
export function useFsRoots() {
  return useQuery({
    queryKey: ['fs', 'roots'],
    queryFn: async () => {
      const { data } = await apiClient.get<DirEntry[]>('/fs/roots');
      return data;
    },
    staleTime: Infinity,
  });
}

/**
 * Подкаталоги выбранной папки. Запрос идёт, только когда путь задан.
 *
 * `fileExtensions` добавляет в список ещё и файлы с этими расширениями — так
 * выбирают архив переноса окружения. Без параметра поведение прежнее: только
 * каталоги (выбор папки проекта).
 */
export function useFsList(path: string | undefined, fileExtensions?: string[]) {
  const files = fileExtensions?.join(',');
  return useQuery({
    queryKey: ['fs', 'list', path, files ?? ''],
    queryFn: async () => {
      const { data } = await apiClient.get<DirListing>('/fs/list', { params: { path, files } });
      return data;
    },
    enabled: Boolean(path),
  });
}

/** Открыть каталог проекта во внешнем редакторе (команда — из настроек). */
export function useOpenInEditor() {
  return useMutation({
    mutationFn: async (path: string) => {
      const { data } = await apiClient.post<{ ok: boolean }>('/projects/open-in-editor', { path });
      return data;
    },
    meta: { successMessage: 'toasts.openingEditor' },
  });
}

export interface EditorInfo {
  id: string;
  name: string;
  command: string;
  available: boolean;
}

/** Редакторы, установленные в системе, — для выбора в настройках. */
export function useEditors() {
  return useQuery({
    queryKey: ['editors'],
    queryFn: async () => {
      const { data } = await apiClient.get<EditorInfo[]>('/editors');
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}
